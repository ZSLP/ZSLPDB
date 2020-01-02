import { SlpTransactionDetails, SlpTransactionType, LocalValidator, Utils, Slp, SlpVersionType, Primatives  } from 'slpjs';
import BigNumber from 'bignumber.js';
import { BITBOX } from 'bitbox-sdk';
import { Config } from './config';
import * as bitcore from 'bitcore-lib-cash';
import { SendTxnQueryResult, MintQueryResult, Query } from './query';
import { Decimal128 } from 'mongodb';
import { Db } from './db';
import { RpcClient } from './rpc';
import * as pQueue from 'p-queue';
import { DefaultAddOptions } from 'p-queue';
import { SlpGraphManager } from './slpgraphmanager';
import { CacheMap } from './cache';
import { SlpdbStatus, SlpdbState } from './status';

let cashaddr = require('cashaddrjs-slp');

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const bitbox = new BITBOX();

export class SlpTokenGraph implements TokenGraph {
    _lastUpdatedBlock!: number;
    _tokenDetails!: SlpTransactionDetails;
    _tokenStats!: TokenStats;
    _tokenUtxos = new Set<string>();
    _mintBatonUtxo = "";
    _nftParentId?: string;
    _graphTxns = new Map<string, GraphTxn>();
    _addresses = new Map<cashAddr, AddressBalance>();
    _slpValidator = new LocalValidator(bitbox, async (txids) => { 
        let txn;
        try {
            txn = <string>await RpcClient.getRawTransaction(txids[0]);
        } catch(err) {
            console.log(`[ERROR] Could not get transaction ${txids[0]} in local validator: ${err}`);
            return [ Buffer.alloc(60).toString('hex') ];
        }
        return [ txn ];
    }, console);
    _network: string;
    _db: Db;
    _graphUpdateQueue: pQueue<DefaultAddOptions> = new pQueue({ concurrency: 1, autoStart: false });
    _statsUpdateQueue: pQueue<DefaultAddOptions> = new pQueue({ concurrency: 1, autoStart: true });
    _manager: SlpGraphManager;
    _liveTxoSpendCache = new CacheMap<string, SendTxnQueryResult>(100000);
    _startupTxoSendCache?: CacheMap<string, SpentTxos>;
    _exit = false;

    constructor(db: Db, manager: SlpGraphManager, network: string) {
        this._db = db;
        this._manager = manager;
        this._network = network;
    }

    async initFromScratch({ tokenDetails, processUpToBlock }: { tokenDetails: SlpTransactionDetails; processUpToBlock?: number; }) {
        await Query.init();
        this._lastUpdatedBlock = 0;
        this._tokenDetails = tokenDetails;

        this._startupTxoSendCache = await Query.getTxoInputSlpSendCache(tokenDetails.tokenIdHex);

        let valid = await this.updateTokenGraphFrom({ txid: tokenDetails.tokenIdHex, processUpToBlock: processUpToBlock });
        if(valid) {
            if(tokenDetails.versionType === SlpVersionType.TokenVersionType1_NFT_Child) {
                await this.setNftParentId();
            } else {
                let mints = await Query.getMintTransactions(tokenDetails.tokenIdHex);
                if(mints && mints.length > 0)
                    await this.asyncForEach(mints, async (m: MintQueryResult) => await this.updateTokenGraphFrom({ txid: m.txid!, processUpToBlock: processUpToBlock, isParent: true }));
            }

            // set genesis block hash
            let genesisBlockHash = await RpcClient.getTransactionBlockHash(this._tokenDetails.tokenIdHex);
            if(genesisBlockHash)
                this._graphTxns.get(this._tokenDetails.tokenIdHex)!.blockHash = Buffer.from(genesisBlockHash, 'hex');

            await this.UpdateStatistics();
        }
        this._startupTxoSendCache.clear();
        this._startupTxoSendCache = undefined;
        this._graphUpdateQueue.start();
    }

    async stop() {
        this._exit = true;
        this._graphUpdateQueue.pause();
        this._graphUpdateQueue.clear();
        if (this._graphUpdateQueue.pending)
            await this._graphUpdateQueue.onIdle();
        this._statsUpdateQueue.pause();
        this._statsUpdateQueue.clear();
        if (this._statsUpdateQueue.pending)
            await this._graphUpdateQueue.onIdle();
    }

    private async setNftParentId() {
        let txnhex = (await this._slpValidator.getRawTransactions([this._tokenDetails.tokenIdHex]))[0];
        let tx = Primatives.Transaction.parseFromBuffer(Buffer.from(txnhex, 'hex'));
        let nftBurnTxnHex = (await this._slpValidator.getRawTransactions([tx.inputs[0].previousTxHash]))[0];
        let nftBurnTxn = Primatives.Transaction.parseFromBuffer(Buffer.from(nftBurnTxnHex, 'hex'));
        let slp = new Slp(bitbox);
        let nftBurnSlp = slp.parseSlpOutputScript(Buffer.from(nftBurnTxn.outputs[0].scriptPubKey));
        if (nftBurnSlp.transactionType === SlpTransactionType.GENESIS) {
            this._nftParentId = tx.inputs[0].previousTxHash;
        }
        else {
            this._nftParentId = nftBurnSlp.tokenIdHex;
        }
    }

    get IsValid(): boolean {
        return this._graphTxns.has(this._tokenDetails.tokenIdHex);
    }

    async asyncForEach(array: any[], callback: Function) {
        for (let index = 0; index < array.length; index++) {
          await callback(array[index], index, array);
        }
    }

    async _updateUtxos(txid: string) {
        let txnHex = (await this._slpValidator.getRawTransactions([txid]))[0];
        let txn = Primatives.Transaction.parseFromBuffer(Buffer.from(txnHex, 'hex'));
        let validation = this._slpValidator.cachedValidations[txid];
        if(validation.validity) {
            if(validation!.details!.transactionType === SlpTransactionType.SEND) {
                txn.inputs.forEach(txo => {
                    if(this._tokenUtxos.delete(`${txo.previousTxHash}:${txo.previousTxOutIndex}`)) {
                        console.log(`[INFO] Token UTXO deleted: ${txo.previousTxHash}:${txo.previousTxOutIndex}`);
                    }
                });
                this._graphTxns.get(txid)!.outputs.forEach(o => {
                    if(!this._tokenUtxos.has(txid + ":" + o.vout) && 
                        o.status !== TokenUtxoStatus.EXCESS_INPUT_BURNED &&
                        o.status !== TokenUtxoStatus.MISSING_BCH_VOUT &&
                        o.status !== TokenUtxoStatus.SPENT_INVALID_SLP &&
                        o.status !== TokenUtxoStatus.SPENT_NON_SLP &&
                        o.status !== TokenUtxoStatus.SPENT_NOT_IN_SEND &&
                        o.status !== TokenUtxoStatus.SPENT_WRONG_TOKEN
                    ){
                        console.log(`[INFO] Token UTXO added: ${txid}:${o.vout}`);
                        this._tokenUtxos.add(txid + ":" + o.vout);
                    }
                });
            }
            else if(validation!.details!.transactionType === SlpTransactionType.MINT) {
                console.log(`[INFO] Token UTXO added: ${txid}:1`);
                this._tokenUtxos.add(txid + ":" + 1);
                txn.inputs.forEach(txo => {
                    if(this._mintBatonUtxo === txo.previousTxHash + ':' + txo.previousTxOutIndex) {
                        let baton = validation.details!.batonVout;
                        let out = this._graphTxns.get(txid)!.outputs.find(o => o.vout === baton);
                        if(baton &&
                            out!.status !== BatonUtxoStatus.BATON_MISSING_BCH_VOUT &&
                            out!.status !== BatonUtxoStatus.BATON_SPENT_INVALID_SLP &&
                            out!.status !== BatonUtxoStatus.BATON_SPENT_NON_SLP &&
                            out!.status !== BatonUtxoStatus.BATON_SPENT_NOT_IN_MINT
                        ){
                            this._mintBatonUtxo = txid + ':' + baton;
                            console.log(`[INFO] Mint baton replaced: ${txid}:${baton}`);
                        } else {
                            this._mintBatonUtxo = '';
                            console.log(`[INFO] Mint baton ended: ${txo.previousTxHash}:${txo.previousTxOutIndex}`);
                        }
                    }
                });
            }
            else if(validation!.details!.transactionType === SlpTransactionType.GENESIS) {
                if(!this._tokenUtxos.has(txid + ":" + 1)) {
                    console.log(`[INFO] Token UTXO added: ${txid}:1`);
                    this._tokenUtxos.add(txid + ":" + 1);
                }

                let baton = validation!.details!.batonVout;
                if(baton && this._mintBatonUtxo !== txid + ':' + baton) {
                    this._mintBatonUtxo = txid + ':' + baton;
                    console.log(`[INFO] Mint baton created: ${txid}:${baton}`);
                }
            }
            else {
                throw Error("Unknown transction type");
            }
        }
    }

    async getMintBatonSpendDetails({ txid, vout, txnOutputLength, processUpTo }: { txid: string; vout: number; txnOutputLength: number; processUpTo?: number }): Promise<MintSpendDetails> {
        let txOut = await RpcClient.getTxOut(txid, vout);
        if(txOut === null) {
            try {
                let spendTxnInfo = await Query.queryForTxoInputAsSlpMint(txid, vout);
                if(!spendTxnInfo) {
                    if(vout < txnOutputLength)
                        return { status: BatonUtxoStatus.BATON_SPENT_NON_SLP, txid: null, invalidReason: null };
                    return { status: BatonUtxoStatus.BATON_MISSING_BCH_VOUT, txid: null, invalidReason: "SLP output has no corresponding BCH output." };
                } else {
                    if(processUpTo && (!spendTxnInfo.block || spendTxnInfo.block > processUpTo)) {
                        //this._mintBatonUtxo = txid + ":" + vout;
                        return { status: BatonUtxoStatus.BATON_UNSPENT, txid: null, invalidReason: null };
                    }
                    if(typeof spendTxnInfo!.txid === 'string') {
                        let valid = await this._slpValidator.isValidSlpTxid(spendTxnInfo.txid!, this._tokenDetails.tokenIdHex);
                        if(!this._slpValidator.cachedValidations[spendTxnInfo.txid!])
                            console.log('SLP Validator is missing transaction', spendTxnInfo.txid, 'for token', this._tokenDetails.tokenIdHex)
                        if(valid && this._slpValidator.cachedValidations[spendTxnInfo.txid!] && this._slpValidator.cachedValidations[spendTxnInfo.txid!].details!.transactionType === SlpTransactionType.MINT)
                            return { status: BatonUtxoStatus.BATON_SPENT_IN_MINT, txid: spendTxnInfo!.txid, invalidReason: null };
                        else if(valid)
                            return { status: BatonUtxoStatus.BATON_SPENT_NOT_IN_MINT, txid: spendTxnInfo!.txid, invalidReason: "Baton was spent in a non-mint SLP transaction." };
                        return { status: BatonUtxoStatus.BATON_SPENT_NON_SLP, txid: spendTxnInfo!.txid, invalidReason: null };
                    }
                }
            } catch(_) {
                if(vout < txnOutputLength)
                    return { status: BatonUtxoStatus.BATON_SPENT_INVALID_SLP, txid: null, invalidReason: this._slpValidator.cachedValidations[txid].invalidReason };
                return { status: BatonUtxoStatus.BATON_MISSING_BCH_VOUT, txid: null, invalidReason: "SLP output has no corresponding BCH output." };
            }
        }
        //this._mintBatonUtxo = txid + ":" + vout;
        return { status: BatonUtxoStatus.BATON_UNSPENT, txid: null, invalidReason: null };
    }

    async getSpendDetails({ txid, vout, txnOutputLength, processUpTo }: { txid: string; vout: number; txnOutputLength: number; processUpTo?: number; }): Promise<SpendDetails> {
        let txOut: any;

        let cachedSpendTxnInfo: SendTxnQueryResult | {txid: string, block: number|null} | undefined
        if(this._startupTxoSendCache)
            cachedSpendTxnInfo = this._startupTxoSendCache.get(txid + ":" + vout);
        if(!cachedSpendTxnInfo)
            cachedSpendTxnInfo = this._liveTxoSpendCache.get(txid + ":" + vout);
        if(!cachedSpendTxnInfo)
            txOut = await RpcClient.getTxOut(txid, vout);
        if(cachedSpendTxnInfo || !txOut) {
            //await this.addNewUtxo()
            //this._tokenUtxos.delete(txid + ":" + vout);
            try {
                let spendTxnInfo: SendTxnQueryResult|{txid: string, block: number|null}|null|undefined;

                // NEED MORE WORK BEFORE WE CAN DO CACHE ONLY STARTUPS
                // if(!cachedSpendTxnInfo && this._startupTxoSendCache) {
                //     console.log("[INFO] TXO IS SPENT BUT, NO SPEND DATA WAS FOUND FOR:", txid, vout);
                // }
                // else if(!cachedSpendTxnInfo) { //&& !this._startupTxoSendCache) {   

                if(!cachedSpendTxnInfo) {
                    spendTxnInfo = await Query.queryForTxoInputAsSlpSend(txid, vout);
                    // only cache mature spends
                    if(spendTxnInfo && 
                        spendTxnInfo.block && 
                        this._manager._bestBlockHeight && 
                        (this._manager._bestBlockHeight - spendTxnInfo.block) > 10
                    ) {
                        this._liveTxoSpendCache.set(txid + ":" + vout, spendTxnInfo!);
                    }
                } else {
                    spendTxnInfo = cachedSpendTxnInfo;
                    console.log("[INFO] Used cached spend data", txid, vout);
                }
                if(!spendTxnInfo) {
                    if(vout < txnOutputLength)
                       return { status: TokenUtxoStatus.SPENT_NON_SLP, txid: null, invalidReason: null };
                    return { status: TokenUtxoStatus.MISSING_BCH_VOUT, txid: null, invalidReason: "SLP output has no corresponding BCH output." };
                } else {
                    if(processUpTo && (!spendTxnInfo.block || spendTxnInfo.block > processUpTo)) {
                        //this._tokenUtxos.add(txid + ":" + vout);
                        return { status: TokenUtxoStatus.UNSPENT, txid: null, invalidReason: null };
                    }
                    if(typeof spendTxnInfo!.txid === 'string') {
                        let valid = await this._slpValidator.isValidSlpTxid(spendTxnInfo.txid!, this._tokenDetails.tokenIdHex);
                        if(!this._slpValidator.cachedValidations[spendTxnInfo.txid!])
                            console.log('SLP Validator is missing transaction', spendTxnInfo.txid, 'for token', this._tokenDetails.tokenIdHex)
                        if(valid && this._slpValidator.cachedValidations[spendTxnInfo.txid!] && this._slpValidator.cachedValidations[spendTxnInfo.txid!].details!.transactionType === SlpTransactionType.SEND)
                            return { status: TokenUtxoStatus.SPENT_SAME_TOKEN, txid: spendTxnInfo!.txid, invalidReason: null };
                        else if(valid)
                            return { status: TokenUtxoStatus.SPENT_NOT_IN_SEND, txid: spendTxnInfo!.txid, invalidReason: null }
                        return { status: TokenUtxoStatus.SPENT_INVALID_SLP, txid: spendTxnInfo!.txid, invalidReason: this._slpValidator.cachedValidations[txid].invalidReason };
                    }
                }
            } catch(_) {
                if(vout < txnOutputLength)
                    return { status: TokenUtxoStatus.SPENT_INVALID_SLP, txid: null, invalidReason: this._slpValidator.cachedValidations[txid].invalidReason };
                return { status: TokenUtxoStatus.MISSING_BCH_VOUT, txid: null, invalidReason: "SLP output has no corresponding BCH output." };
            }
        }
        //await this.addNewUtxo(txid, vout);
        //this._tokenUtxos.add(txid + ":" + vout);
        return { status: TokenUtxoStatus.UNSPENT, txid: null, invalidReason: null };
    }

    async queueTokenGraphUpdateFrom({ txid, isParent = false, processUpToBlock, block=null }: { txid: string, isParent?: boolean, processUpToBlock?: number; block?:{ hash: Buffer; transactions: Set<string> }|null}): Promise<void> {
        let self = this;
        return await this._graphUpdateQueue.add(async function() {
            await self.updateTokenGraphFrom({ txid, isParent, processUpToBlock, block });

            // Update the confirmed/unconfirmed collections with token details
            await self._manager.updateTxnCollections(txid, self._tokenDetails.tokenIdHex);

            // zmq publish mempool notifications
            if(!isParent)
                await self._manager.publishZmqNotification(txid);

            // Update token's statistics
            if(self._graphUpdateQueue.size === 0 && self._graphUpdateQueue.pending === 1) {
                // if block then we should check for double-spends for all graph txns with null blockHash
                if(block) {
                    let txnsWithNoBlock = Array.from(self._graphTxns).filter(i => !i[1].blockHash);
                    let mempool = await RpcClient.getRawMemPool();
                    await self.asyncForEach(txnsWithNoBlock, async (i: [string, GraphTxn]) => {
                        let txid = i[0];
                        if(!mempool.includes(txid)) {
                            try {
                                await RpcClient.getRawTransaction(txid);
                            } catch(err) {
                                console.log(`[ERROR] Could not get transaction ${txid} in queueTokenGraphUpdateFrom: ${err}`)
                                self._graphTxns.delete(txid);
                                delete self._slpValidator.cachedRawTransactions[txid];
                                delete self._slpValidator.cachedValidations[txid];
                                self._liveTxoSpendCache.clear();
                            }
                        }
                    });
                }
                self._liveTxoSpendCache.clear();
                await self.UpdateStatistics();
            }
        })
    }

    async updateTokenGraphFrom({ txid, isParent = false, updateOutputs = true, processUpToBlock, block=null }: { txid: string; isParent?:boolean; updateOutputs?: boolean; processUpToBlock?: number; block?: { hash: Buffer; transactions: Set<string> }|null}): Promise<boolean|null> {
/**
 * purpose for "isParent":
 *      1) skips cached result, allow reprocessing/updating of a previously processed valid txn
 *      2) prevents recursive reprocessing of a parent txn's inputs (since we only want to update output status for 1 group of parents)
 *      3) prevents recursive processing of outputs (since the calling child will do this)
 */

        if(block) {
            if(!(block.transactions.has(txid))) {
                try {
                    await RpcClient.getTransactionBlockHash(txid);
                } catch (_) {
                    this.deleteAllChildren(txid, true);
                    return null;
                }
                if(!this._graphTxns.has(txid)) {
                    this.queueTokenGraphUpdateFrom({ txid });
                }
                return null;
            }

            if(this._graphTxns.has(txid)) {
                let graphTxn = this._graphTxns.get(txid)!;
                // TODO: check each output. If the output is already marked spent, then verify the spend txid is correct.
                for(let i=0; i< graphTxn.outputs.length;i++) {
                    console.log(`[INFO] Checking block transaction output ${i} (${txid})`);
                    let status = graphTxn.outputs[i].status;
                    let spendTxid = graphTxn.outputs[i].spendTxid;
                    let skip = [ TokenUtxoStatus.UNSPENT, 
                                    TokenUtxoStatus.EXCESS_INPUT_BURNED, 
                                    TokenUtxoStatus.MISSING_BCH_VOUT,
                                    BatonUtxoStatus.BATON_UNSPENT,
                                    BatonUtxoStatus.BATON_MISSING_BCH_VOUT ];
                    if(!skip.includes(status)) {
                        if(spendTxid) {
                            try {
                                await RpcClient.getRawTransaction(txid);
                            } catch(err) {
                                console.log(`[ERROR] Could not get transaction ${txid} in updateTokenGraphFrom: ${err}`)
                                console.log(`[INFO] Found an output with non-existant spend txid.`);
                                console.log(`[INFO] Will delete ${spendTxid} and all txns downstream.`);
                                this.deleteAllChildren(spendTxid, true);
                            }
                        }
                    }
                }
                graphTxn.blockHash = block ? block.hash : null;
                isParent = true;
            }
        }

        if(this._graphTxns.has(txid) && !isParent && this._graphTxns.get(txid)!.isComplete) {   
            return true;
        }

        let isValid = await this._slpValidator.isValidSlpTxid(txid, this._tokenDetails.tokenIdHex);
        let txnSlpDetails = this._slpValidator.cachedValidations[txid].details;
        let txn: bitcore.Transaction = new bitcore.Transaction(await this._slpValidator.retrieveRawTransaction(txid));

        if (!isValid) {
            console.log("[WARN] updateTokenGraphFrom: Not valid token transaction:", txid);        
            return false;
        }

        if(!txnSlpDetails) {
            console.log("[WARN] updateTokenGraphFrom: No token details for:", txid);
            return false;
        }

        let graphTxn: GraphTxn;
        if(!this._graphTxns.has(txid)) {
            graphTxn = { details: txnSlpDetails, outputs: [], inputs: [], blockHash: block ? block.hash : null };
            this._graphTxns.set(txid, graphTxn);
        }
        else {
            graphTxn = this._graphTxns.get(txid)!;
        }
        console.log("[INFO] Valid txns", this._graphTxns.size);

        // Add contributing SLP inputs
        if(graphTxn.inputs.length === 0) {
            await this.asyncForEach(txn.inputs, async (i: bitcore.TxnInput) => {
                let previd = i.prevTxId.toString('hex');
                if(!this._slpValidator.cachedValidations[previd]) {
                    await this._slpValidator.isValidSlpTxid(previd, this._tokenDetails.tokenIdHex);
                }
                if(this._slpValidator.cachedValidations[previd] && 
                    this._slpValidator.cachedValidations[previd].validity && 
                    this._slpValidator.cachedValidations[previd].details!.tokenIdHex === this._tokenDetails.tokenIdHex
                ){
                    if(!this._graphTxns.has(previd)) {
                        console.log("[INFO] updateTokenGraphFrom: Add contributing SLP inputs");
                        await this.updateTokenGraphFrom({ txid: previd, isParent: true, updateOutputs: false });
                    }
                    let input = this._graphTxns.get(i.prevTxId.toString('hex'))!
                    let o = input.outputs.find(o => o.vout === i.outputIndex);
                    if(o) {
                        graphTxn.inputs.push({
                            txid: i.prevTxId.toString('hex'),
                            vout: i.outputIndex,
                            slpAmount: o.slpAmount,
                            address: o.address,
                            bchSatoshis: o.bchSatoshis
                        })
                    }
                }
            })
        }

        // Wait for mempool and block sync to complete before proceeding to update anything on graph.
        while(!this._manager.TnaSynced) {
            console.log("[INFO] At updateTokenGraphFrom() - Waiting for TNA sync to complete before starting graph updates.");
            await sleep(500);
        }

        // Create or update SLP graph outputs for each valid SLP output
        if(updateOutputs || graphTxn.outputs.length === 0) {
            graphTxn.outputs = [];
            if(graphTxn.details.transactionType === SlpTransactionType.GENESIS || graphTxn.details.transactionType === SlpTransactionType.MINT) {
                if(graphTxn.details.genesisOrMintQuantity!.isGreaterThanOrEqualTo(0)) {
                    let spendDetails = await this.getSpendDetails({ txid, vout: 1, txnOutputLength: txn.outputs.length, processUpTo: processUpToBlock });
                    let address = this.getAddressStringFromTxnOutput(txn, 1);
                    graphTxn.outputs.push({
                        address: address,
                        vout: 1,
                        bchSatoshis: txn.outputs.length > 1 ? txn.outputs[1].satoshis : 0, 
                        slpAmount: <any>graphTxn.details.genesisOrMintQuantity!,
                        spendTxid: spendDetails.txid,
                        status: spendDetails.status,
                        invalidReason: spendDetails.invalidReason
                    })
                    if(txnSlpDetails.batonVout) {
                        let mintSpendDetails = await this.getMintBatonSpendDetails({ txid, vout: txnSlpDetails.batonVout, txnOutputLength: txn.outputs.length, processUpTo: processUpToBlock });
                        let address = this.getAddressStringFromTxnOutput(txn, 1);
                        graphTxn.outputs.push({
                            address: address,
                            vout: txnSlpDetails.batonVout,
                            bchSatoshis: txnSlpDetails.batonVout < txn.outputs.length ? txn.outputs[txnSlpDetails.batonVout].satoshis : 0, 
                            slpAmount: new BigNumber(0),
                            spendTxid: mintSpendDetails.txid,
                            status: mintSpendDetails.status,
                            invalidReason: mintSpendDetails.invalidReason
                        })
                    }
                }
            }
            else if(graphTxn.details.sendOutputs!.length > 0) {
                await this.asyncForEach(graphTxn.details.sendOutputs!, async (output: BigNumber, slp_vout: number) => { 
                    if(output.isGreaterThanOrEqualTo(0)) {
                        if(slp_vout > 0) {
                            let spendDetails = await this.getSpendDetails({ txid, vout: slp_vout, txnOutputLength: txn.outputs.length, processUpTo: processUpToBlock });
                            let address = this.getAddressStringFromTxnOutput(txn, slp_vout);
                            graphTxn.outputs.push({
                                address: address,
                                vout: slp_vout,
                                bchSatoshis: slp_vout < txn.outputs.length ? txn.outputs[slp_vout].satoshis : 0, 
                                slpAmount: graphTxn.details.sendOutputs![slp_vout],
                                spendTxid: spendDetails.txid,
                                status: spendDetails.status,
                                invalidReason: spendDetails.invalidReason
                            })
                        }
                    }
                })

            }
            else {
                console.log("[WARNING]: Transaction is not valid or is unknown token type!", txid);
            }
            await this._updateUtxos(txid);
        }

        // check for possible inputs burned due to outputs < inputs
        if((updateOutputs || graphTxn.outputs.length === 0) && graphTxn.details.sendOutputs && graphTxn.details.sendOutputs!.length > 0) {
            let inputQty = graphTxn.inputs.reduce((a, c) => a.plus(c.slpAmount), new BigNumber(0));
            let outputQty = graphTxn.outputs.reduce((a, c) => a.plus(c.slpAmount), new BigNumber(0));
            if(inputQty.isGreaterThan(outputQty)) {
                graphTxn.outputs.push(<any>{
                    slpAmount: inputQty.minus(outputQty),
                    status: TokenUtxoStatus.EXCESS_INPUT_BURNED
                })
            }
        }

        // Update the status of each input txn's outputs -- add to token's update queue
        if(!isParent && this._manager._startupQueue.size === 0 && this._manager._startupQueue.pending === 0) {
            let parentIds = new Set<string>([...txn.inputs.map(i => i.prevTxId.toString('hex'))])
            await this.asyncForEach(Array.from(parentIds), async (txid: string) => {
                if(this._graphTxns.get(txid)!) {
                    console.log("[INFO] updateTokenGraphFrom: update the status of each input txn's outputs");
                    this.queueTokenGraphUpdateFrom({ txid, isParent: true });
                }
            });
        }

        // Continue to complete graph from output UTXOs
        if(!isParent) {
            await this.asyncForEach(graphTxn.outputs.filter(o => o.spendTxid && (o.status === TokenUtxoStatus.SPENT_SAME_TOKEN || o.status === BatonUtxoStatus.BATON_SPENT_IN_MINT)), async (o: GraphTxnOutput) => {
                console.log("[INFO] updateTokenGraphFrom: Continue to complete graph from output UTXOs");
                await this.updateTokenGraphFrom({ txid: o.spendTxid!, processUpToBlock, block });
            });
            graphTxn.isComplete = true;
        }

        if(!processUpToBlock)
            this._lastUpdatedBlock = this._manager._bestBlockHeight; //await this._rpcClient.getBlockCount();
        else
            this._lastUpdatedBlock = processUpToBlock;

        return true;
    }

    private deleteAllChildren(txid: string, deleteSelf=false) {
        let toDelete = new Set<string>();
        let self = this;
        let getChildTxids = function(txid: string) {
            let n = self._graphTxns.get(txid)!;
            if(n) {
                n.outputs.forEach((o, i) => { 
                    if(o.spendTxid && !toDelete.has(o.spendTxid)) {
                        toDelete.add(o.spendTxid);
                        getChildTxids(o.spendTxid);
                    }
                });
                n.outputs = [];
                n.isComplete = false;
            }
        }
        getChildTxids(txid);
        if(deleteSelf)
            toDelete.add(txid);
        toDelete.forEach(txid => {
            // must find any graphTxn with an output spendTxid equal to txid
            this._graphTxns.get(txid)!.inputs.forEach((v, i) => {
                if(this._graphTxns.has(v.txid)) {
                    let g = this._graphTxns.get(v.txid)!;
                    let output = g.outputs.find(o => o.vout === v.vout);
                    output!.spendTxid = null;
                    output!.status = TokenUtxoStatus.UNSPENT;
                    this._tokenUtxos.add(`${txid}:${v.vout}`);
                }
            });
            this._graphTxns.delete(txid);
            delete this._slpValidator.cachedRawTransactions[txid];
            delete this._slpValidator.cachedValidations[txid];
        });
        this._tokenUtxos.forEach(txo => {
            let txid = txo.split(':')[0];
            if(toDelete.has(txid))
                this._tokenUtxos.delete(txo);
        });
    }

    private getAddressStringFromTxnOutput(txn: bitcore.Transaction, outputIndex: number) {
        let address;
        try {
            address = Utils.toSlpAddress(bitbox.Address.fromOutputScript(txn.outputs[outputIndex]._scriptBuffer, this._network));
        }
        catch (_) {
            try {
                address = 'scriptPubKey:' + txn.outputs[outputIndex]._scriptBuffer.toString('hex');
            }
            catch (_) {
                address = 'Missing transaction output.';
            }
        }
        return address;
    }

    async updateAddressesFromScratch(): Promise<void> {
        this._addresses.clear();

        await this.asyncForEach(Array.from(this._tokenUtxos), async (utxo: string) => {
            let txid = utxo.split(':')[0];
            let vout = parseInt(utxo.split(':')[1]);

            let txout: GraphTxnOutput|undefined;
            try {
                txout = this._graphTxns.get(txid)!.outputs.find(o => vout === o.vout);
            } catch(_) {
                await this.updateTokenGraphFrom({ txid });
                if(!this._tokenUtxos.has(utxo))
                    return
                if(!this._graphTxns.has(txid)) {
                    this._tokenUtxos.delete(utxo);
                    return
                }
                txout = this._graphTxns.get(txid)!.outputs.find(o => vout === o.vout);
            }
            
            if(txout) {
                let graph = this._graphTxns.get(txid)!
                let txnDetails = graph.details;
                let addr = txout.address;
                let bal;
                if(graph.outputs[vout-1].status !== TokenUtxoStatus.UNSPENT && graph.outputs[vout-1].status !== BatonUtxoStatus.BATON_UNSPENT) {
                    console.log(graph.outputs);
                    console.log(`[INFO] TXO is not unspent (deleting from token UTXO set): ${txid}:${vout}`);
                    this._tokenUtxos.delete(utxo);
                    return;
                }
                if(this._addresses.has(addr)) {
                    bal = this._addresses.get(addr)!
                    bal.satoshis_balance+=txout.bchSatoshis
                    if(txnDetails.transactionType === SlpTransactionType.SEND)
                        bal.token_balance = bal.token_balance.plus(txnDetails.sendOutputs![vout])
                    else if(vout === 1)
                        bal.token_balance = bal.token_balance.plus(txnDetails.genesisOrMintQuantity!)
                }
                else {
                    if(txnDetails.transactionType === SlpTransactionType.SEND)
                        bal = { satoshis_balance: txout.bchSatoshis, token_balance: txnDetails.sendOutputs![vout] }
                    else if(vout === 1)
                        bal = { satoshis_balance: txout.bchSatoshis, token_balance: txnDetails.genesisOrMintQuantity! }
                }

                if(bal && bal.token_balance.isGreaterThan(0)) {
                    this._addresses.set(addr, <any>bal);
                }
            }
        });
    }

    async getTotalMintQuantity(): Promise<BigNumber> {
        let qty = this._tokenDetails.genesisOrMintQuantity;
        if(!qty)
            throw Error("Cannot have Genesis without quantity.");
        this._graphTxns.forEach(t => {
            if(t.details.transactionType === SlpTransactionType.MINT)
                qty = qty!.plus(t.details.genesisOrMintQuantity!)
        })
        return qty;
    }

    getTotalHeldByAddresses(): BigNumber {
        let qty = new BigNumber(0);
        this._addresses.forEach(a => qty = qty.plus(a.token_balance))
        return qty;
    }

    getTotalSatoshisLockedUp(): number {
        let qty = 0;
        this._addresses.forEach(a => qty+=a.satoshis_balance);
        return Math.round(qty);
    }

    async getBatonStatus(): Promise<TokenBatonStatus> {
        if(!this._tokenDetails.containsBaton)
            return TokenBatonStatus.NEVER_CREATED;
        else if(this._tokenDetails.containsBaton === true) {
            if(this._mintBatonUtxo.includes(this._tokenDetails.tokenIdHex + ":" + this._tokenDetails.batonVout))
                return TokenBatonStatus.ALIVE;
            let mintTxids = Array.from(this._graphTxns).filter(o => o[1].details.transactionType === SlpTransactionType.MINT).map(o => o[0]);
            let mints = mintTxids.map(i => this._slpValidator.cachedValidations[i])
            if(mints) {
                for(let i = 0; i < mints!.length; i++) {
                    let valid = mints[i].validity;
                    let vout = mints[i].details!.batonVout;
                    if(valid && vout && this._mintBatonUtxo.includes(mintTxids[i] + ":" + vout))
                        return TokenBatonStatus.ALIVE;
                    if(valid && !vout)
                        return TokenBatonStatus.DEAD_ENDED;
                }
            }
        }
        return TokenBatonStatus.DEAD_BURNED;
    }

    async searchForNonSlpBurnTransactions(): Promise<void> {
        await this.asyncForEach(Array.from(this._tokenUtxos), async (txo: string) => {
            await this.updateTxoIfSpent(txo)
        })
        if(this._mintBatonUtxo !== "")
            await this.updateTxoIfSpent(this._mintBatonUtxo);
    }

    async updateTxoIfSpent(txo: string) {
        let txid = txo.split(":")[0];
        let vout = parseInt(txo.split(":")[1]);
        let txout = null;
        try {
            txout = await RpcClient.getTxOut(txid, vout);
        } catch(_) { }
        if(!txout) {
            // check for a double spent transaction
            let txn;
            try {
                txn = await RpcClient.getRawTransaction(txid);
            } catch(err) {
                console.log(`[ERROR] Could not get transaction ${txid} in updateTxoIfSpent: ${err}`);
            }
            if(txn) {
                console.log("[INFO] updateTxoIfSpent(): Updating token graph for TXO",txo);
                await this.updateTokenGraphFrom({ txid, isParent: true });
            } else {
                let gt = this._graphTxns.get(txid);
                if(gt) {
                    this._slpValidator.cachedValidations[txid].validity = false;
                    for(let i = 0; i < gt.inputs.length; i++) {
                        let igt = this._graphTxns.get(gt.inputs[i].txid)
                        if(igt) {
                            igt.outputs = [];
                        }
                        await this.updateTokenGraphFrom({ txid: gt.inputs[i].txid, isParent: true });
                    }
                    console.log("[INFO] updateTxoIfSpent(): Removing unknown transaction from token graph.",txo);
                    let outlength = gt.outputs.length;
                    this._graphTxns.delete(txid);
                    for(let i = 0; i < outlength; i++) {
                        let txo = txid + ":" + vout;
                        let deleted = this._tokenUtxos.delete(txo);
                        if(deleted)
                            console.log("[INFO] updateTxoIfSpent(): Removing utxo for unknown transaction", txo);
                    }
                }
            }
        }
    }

    async _checkGraphBlockHashes() {
        // update blockHash for each graph item.
        if(this._startupTxoSendCache) {
            let blockHashes = new Map<string, Buffer|null>();
            Array.from(this._startupTxoSendCache.toMap()).forEach(i => {
                blockHashes.set(i[1].txid, i[1].blockHash);
            });
            blockHashes.forEach((v, k) => {
                if(this._graphTxns.has(k))
                    this._graphTxns.get(k)!.blockHash = v;
            });
        }
        let count = 0;
        for(let key of Array.from( this._graphTxns.keys() )) {
            if(this._graphTxns.has(key) && 
                !this._graphTxns.get(key)!.blockHash && 
                !this._manager._bit.slpMempool.has(key))
            {
                let hash: string;
                console.log("[INFO] Querying block hash for graph transaction", key);
                try {
                    hash = await RpcClient.getTransactionBlockHash(key);
                    console.log(`[INFO] Block hash: ${hash} for ${key}`);
                    // add delay to prevent flooding rpc
                    if(count++ > 1000) {
                        await sleep(1000);
                        count = 0;
                    }
                } catch(_) {
                    console.log("[INFO] Removing unknown transaction", key);
                    this._graphTxns.delete(key);
                    continue;
                }
                if(hash) {
                    console.log("[INFO] Updating block hash for", key);
                    this._graphTxns.get(key)!.blockHash = Buffer.from(hash, 'hex');
                } 
                else if(this._manager._bit.slpMempool.has(key)) {
                    continue;
                } 
                else {
                    console.log("[INFO] Making sure thransaction is in BCH mempool.");
                    let mempool = await RpcClient.getRawMemPool();
                    if(mempool.includes(key)) {
                        continue;
                    }
                    throw Error(`Unknown error occured in setting blockhash for ${key})`);
                }
            }
        }

        // TODO: remove temporary paranoia
        for(let key of Array.from( this._graphTxns.keys() )) {
            if(!this._graphTxns.get(key)!.blockHash && !this._manager._bit.slpMempool.has(key)) {
                if(SlpdbStatus.state === SlpdbState.RUNNING)
                    throw Error(`No blockhash for ${key}`);
                else
                    console.log('[INFO] Allowing missing block hash during startup conditions.');
            }
        }
    }

    async UpdateStatistics(saveToDb=true): Promise<void> {
        let self = this;
        await this._statsUpdateQueue.add(async function() {
            await self._updateStatistics(saveToDb);
        });
    }

    async _updateStatistics(saveToDb=true): Promise<void> {
        if(this.IsValid && this._graphUpdateQueue.size === 0) {
            await this.updateAddressesFromScratch();
            await this._checkGraphBlockHashes();
            let block_created = await Query.queryTokenGenesisBlock(this._tokenDetails.tokenIdHex);
            let block_last_active_mint = await Query.blockLastMinted(this._tokenDetails.tokenIdHex);
            let block_last_active_send = await Query.blockLastSent(this._tokenDetails.tokenIdHex);
            let qty_token_minted = await this.getTotalMintQuantity();
            let minting_baton_status = await this.getBatonStatus();

            this._tokenStats = <TokenStats> {
                block_created: block_created,
                block_last_active_mint: block_last_active_mint,
                block_last_active_send: block_last_active_send,
                qty_valid_txns_since_genesis: this._graphTxns.size,
                qty_valid_token_utxos: this._tokenUtxos.size,
                qty_valid_token_addresses: this._addresses.size,
                qty_token_minted: qty_token_minted,
                qty_token_burned: new BigNumber(0),
                qty_token_circulating_supply: this.getTotalHeldByAddresses(),
                qty_satoshis_locked_up: this.getTotalSatoshisLockedUp(),
                minting_baton_status: minting_baton_status
            }
            this._tokenStats.qty_token_burned = this._tokenStats.qty_token_minted.minus(this._tokenStats.qty_token_circulating_supply)

            if(this._tokenStats.qty_token_circulating_supply.isGreaterThan(this._tokenStats.qty_token_minted)) {
                console.log("[ERROR] Cannot have circulating supply larger than total minted quantity.");
                //console.log("[INFO] Statistics will be recomputed after update queue is cleared.");
                // TODO: handle this condition gracefully.
            }

            if(!this._tokenStats.qty_token_circulating_supply.isEqualTo(this._tokenStats.qty_token_minted.minus(this._tokenStats.qty_token_burned))) {
                console.log("[WARN] Circulating supply minus burn quantity does not equal minted quantity");
                //console.log("[INFO] Statistics will be recomputed after update queue is cleared.");
                // TODO: handle this condition gracefully.
            }

            if(saveToDb && !this._exit) {
                await this._db.tokenInsertReplace(this.toTokenDbObject());
                await this._db.addressInsertReplace(this.toAddressesDbObject(), this._tokenDetails.tokenIdHex);
                await this._db.graphInsertReplace(this.toGraphDbObject(), this._tokenDetails.tokenIdHex);
                await this._db.utxoInsertReplace(this.toUtxosDbObject(), this._tokenDetails.tokenIdHex);
            }

            console.log("########################################################################################################")
            console.log("TOKEN STATS/ADDRESSES FOR", this._tokenDetails.name, this._tokenDetails.tokenIdHex)
            console.log("########################################################################################################")
            this.logTokenStats();
            this.logAddressBalances();
        }
    }

    logTokenStats(): void {
        console.log("TOKEN STATS:")
        console.log({
            block_created: this._tokenStats.block_created,
            block_last_active_mint: this._tokenStats.block_last_active_mint,
            block_last_active_send: this._tokenStats.block_last_active_send,
            qty_valid_txns_since_genesis: this._tokenStats.qty_valid_txns_since_genesis,
            qty_valid_token_utxos: this._tokenStats.qty_valid_token_utxos,
            qty_valid_token_addresses: this._tokenStats.qty_valid_token_addresses,
            qty_token_minted: this._tokenStats.qty_token_minted.dividedBy(10**this._tokenDetails.decimals).toFixed(),
            qty_token_burned: this._tokenStats.qty_token_burned.dividedBy(10**this._tokenDetails.decimals).toFixed(),
            qty_token_circulating_supply: this._tokenStats.qty_token_circulating_supply.dividedBy(10**this._tokenDetails.decimals).toFixed(),
            qty_satoshis_locked_up: this._tokenStats.qty_satoshis_locked_up,
            minting_baton_status: this._tokenStats.minting_baton_status
        })
    }

    logAddressBalances(): void {
        console.log("ADDRESS BALANCES:")
        console.log(Array.from(this._addresses).map((v, _, __) => { 
                return { 
                    addr: v[0], 
                    bal: v[1].token_balance.dividedBy(10**this._tokenDetails.decimals).toFixed() 
                }
            })
        )
    }

    toTokenDbObject(): TokenDBObject {
        let tokenDetails = SlpTokenGraph.MapTokenDetailsToDbo(this._tokenDetails, this._tokenDetails.decimals);

        let result: TokenDBObject = {
            schema_version: Config.db.token_schema_version,
            lastUpdatedBlock: this._lastUpdatedBlock,
            tokenDetails: tokenDetails,
            mintBatonUtxo: this._mintBatonUtxo,
            tokenStats: this.mapTokenStatstoDbo(this._tokenStats),
        }
        if(this._nftParentId) {
            result.nftParentId = this._nftParentId;
        }
        return result;
    }

    toAddressesDbObject(): AddressBalancesDbo[] {
        let tokenDetails = SlpTokenGraph.MapTokenDetailsToDbo(this._tokenDetails, this._tokenDetails.decimals);
        let result: AddressBalancesDbo[] = [];
        Array.from(this._addresses).forEach(a => { 
            result.push({ 
                tokenDetails: { tokenIdHex: tokenDetails.tokenIdHex }, 
                address: a[0], 
                satoshis_balance: a[1].satoshis_balance, 
                token_balance: Decimal128.fromString(a[1].token_balance.dividedBy(10**this._tokenDetails.decimals).toFixed()) 
            }) 
        })
        return result;
    }

    toUtxosDbObject(): UtxoDbo[] {
        let result: UtxoDbo[] = [];
        Array.from(this._tokenUtxos).forEach(u => {
            let txid = u.split(":")[0];
            let vout = u.split(":")[1];
            let output = this.utxoToUtxoDbo(txid, vout);
            if(output)
                result.push(output);
        });
        return result;
    }

    utxoToUtxoDbo(txid: string, vout: string) {
        if(!this._graphTxns.has(txid)) {
            this._tokenUtxos.delete(`${txid}:${vout}`);
            return undefined;
        }
        let output = this._graphTxns.get(txid)!.outputs.find(o => o.vout == parseInt(vout));
        if (output) {
            return <UtxoDbo>{
                tokenDetails: {
                    tokenIdHex: this._tokenDetails.tokenIdHex
                },
                utxo: txid + ":" + vout,
                txid: txid,
                vout: parseInt(vout),
                address: output.address,
                bchSatoshis: output.bchSatoshis,
                slpAmount: Decimal128.fromString(output.slpAmount.dividedBy(10 ** this._tokenDetails.decimals).toFixed())
            };
        }
        return undefined;
    }

    toGraphDbObject(): GraphTxnDbo[] {
        let tokenDetails = SlpTokenGraph.MapTokenDetailsToDbo(this._tokenDetails, this._tokenDetails.decimals);
        let result: GraphTxnDbo[] = [];
        Array.from(this._graphTxns).forEach(k => {
            result.push({
                tokenDetails: { tokenIdHex: tokenDetails.tokenIdHex }, 
                graphTxn: {
                    txid: k[0],
                    details: SlpTokenGraph.MapTokenDetailsToDbo(this._graphTxns.get(k[0])!.details, this._tokenDetails.decimals),
                    outputs: this.mapGraphTxnOutputsToDbo(this._graphTxns.get(k[0])!.outputs),
                    inputs: this._graphTxns.get(k[0])!.inputs.map((i) => { 
                        return {
                            address: i.address,
                            txid: i.txid,
                            vout: i.vout,
                            bchSatoshis: i.bchSatoshis,
                            slpAmount: Decimal128.fromString(i.slpAmount.dividedBy(10**this._tokenDetails.decimals).toFixed())
                        }
                    }),
                    stats: k[1].stats,
                    blockHash: k[1].blockHash
                }
            })
        });
        return result;
    }

    mapGraphTxnOutputsToDbo(outputs: GraphTxnOutput[]): GraphTxnOutputDbo[] {
        let mapped: GraphTxnDetailsDbo["outputs"] = [];
        outputs.forEach(o => {
                let m = Object.create(o);
                //console.log(m);
                try {
                    m.slpAmount = Decimal128.fromString(m.slpAmount.dividedBy(10**this._tokenDetails.decimals).toFixed());
                } catch(_) {
                    m.slpAmount = Decimal128.fromString("0");
                }
                mapped.push(m);
        })
        return mapped;
    }

    mapTokenStatstoDbo(stats: TokenStats): TokenStatsDbo {
        return {
            block_created: stats.block_created,
            block_last_active_send: stats.block_last_active_send,
            block_last_active_mint: stats.block_last_active_mint,
            qty_valid_txns_since_genesis: stats.qty_valid_txns_since_genesis,
            qty_valid_token_utxos: stats.qty_valid_token_utxos,
            qty_valid_token_addresses: stats.qty_valid_token_addresses,
            qty_token_minted: Decimal128.fromString(stats.qty_token_minted.dividedBy(10**this._tokenDetails.decimals).toFixed()),
            qty_token_burned: Decimal128.fromString(stats.qty_token_burned.dividedBy(10**this._tokenDetails.decimals).toFixed()),
            qty_token_circulating_supply: Decimal128.fromString(stats.qty_token_circulating_supply.dividedBy(10**this._tokenDetails.decimals).toFixed()),
            qty_satoshis_locked_up: stats.qty_satoshis_locked_up,
            minting_baton_status: stats.minting_baton_status
        }
    }

    static MapTokenDetailsToDbo(details: SlpTransactionDetails, decimals: number): SlpTransactionDetailsDbo {
        let res: SlpTransactionDetailsDbo = {
            decimals: details.decimals,
            tokenIdHex: details.tokenIdHex,
            timestamp: details.timestamp ? details.timestamp : null,
            timestamp_unix: details.timestamp ? this.ConvertToUnixTime(details.timestamp) : null,
            transactionType: details.transactionType,
            versionType: details.versionType,
            documentUri: details.documentUri,
            documentSha256Hex: details.documentSha256 ? details.documentSha256.toString('hex') : null,
            symbol: details.symbol,
            name: details.name,
            batonVout: details.batonVout,
            containsBaton: details.containsBaton ? true : false,
            genesisOrMintQuantity: details.genesisOrMintQuantity ? Decimal128.fromString(details.genesisOrMintQuantity!.dividedBy(10**decimals).toFixed()) : null,
            sendOutputs: details.sendOutputs ? details.sendOutputs.map(o => Decimal128.fromString(o.dividedBy(10**decimals).toFixed())) : null
        }

        return res;
    }
    
    static ConvertToUnixTime(Y_m_d_H_M_S: string): number|null {
        // timestamp is formatted as "%Y-%m-%d %H:%M:%S"
        if(Y_m_d_H_M_S) {
            let d = Y_m_d_H_M_S.split(" ")[0] + "T" + Y_m_d_H_M_S.split(" ")[1] + "Z";
            return Date.parse(d)/1000;
        }
        return null;
    }

    static FormatUnixToDateString(unix_time: number): string {
        var date = new Date(unix_time*1000);
        return date.toISOString().replace("T", " ").replace(".000Z", "")
    }

    static MapDbTokenDetailsFromDbo(details: SlpTransactionDetailsDbo, decimals: number): SlpTransactionDetails {

        let genesisMintQty = new BigNumber(0);
        if(details.genesisOrMintQuantity)
            genesisMintQty = new BigNumber(details.genesisOrMintQuantity.toString()).multipliedBy(10**decimals);
        
        let sendOutputs: BigNumber[] = [];
        if(details.sendOutputs)
            sendOutputs = details.sendOutputs.map(o => o = <any>new BigNumber(o.toString()).multipliedBy(10**decimals));

        let res = {
            decimals: details.decimals,
            tokenIdHex: details.tokenIdHex,
            timestamp: details.timestamp!,
            transactionType: details.transactionType,
            versionType: details.versionType,
            documentUri: details.documentUri,
            documentSha256: details.documentSha256Hex ? Buffer.from(details.documentSha256Hex, 'hex') : null,
            symbol: details.symbol,
            name: details.name,
            batonVout: details.batonVout,
            containsBaton: details.containsBaton,
            genesisOrMintQuantity: details.genesisOrMintQuantity ? genesisMintQty : null,
            sendOutputs: details.sendOutputs ? sendOutputs as any as BigNumber[] : null
        }

        return res;
    }

    static async FromDbObjects(token: TokenDBObject, dag: GraphTxnDbo[], utxos: UtxoDbo[], addresses: AddressBalancesDbo[], db: Db, manager: SlpGraphManager, network: string): Promise<SlpTokenGraph> {
        let tg = new SlpTokenGraph(db, manager, network);
        await Query.init();

        // add minting baton
        tg._mintBatonUtxo = token.mintBatonUtxo;

        // add nft parent id
        if(token.nftParentId)
            tg._nftParentId = token.nftParentId;

        tg._network = network;

        // Map _tokenDetails
        tg._tokenDetails = this.MapDbTokenDetailsFromDbo(token.tokenDetails, token.tokenDetails.decimals);

        // Map _txnGraph
        dag.forEach((item, idx) => {
            dag[idx].graphTxn.outputs.map(o => {
                if(o.address && o.address.includes("zslp")) {
                    let decoded = cashaddr.decode(o.address);
                    o.address = Utils.slpAddressFromHash160(decoded.hash, tg._network);
                }
                o.slpAmount = <any>new BigNumber(o.slpAmount.toString()).multipliedBy(10**tg._tokenDetails.decimals)
            }) 
            dag[idx].graphTxn.inputs.map(o => o.slpAmount = <any>new BigNumber(o.slpAmount.toString()).multipliedBy(10**tg._tokenDetails.decimals))

            let gt: GraphTxn = {
                details: this.MapDbTokenDetailsFromDbo(dag[idx].graphTxn.details, token.tokenDetails.decimals),
                outputs: dag[idx].graphTxn.outputs as any as GraphTxnOutput[],
                inputs: dag[idx].graphTxn.inputs as any as GraphTxnInput[],
                stats: dag[idx].graphTxn.stats,
                blockHash: dag[idx].graphTxn.blockHash
            }
            tg._graphTxns.set(item.graphTxn.txid, gt);
        })

        // Preload SlpValidator with cachedValidations
        let txids = Array.from(tg._graphTxns.keys());
        txids.forEach(txid => {
            let validation: any = { validity: null, details: null, invalidReason: null, parents: [], waiting: false }
            validation.validity = tg._graphTxns.get(txid) ? true : false;
            validation.details = tg._graphTxns.get(txid)!.details;
            if(!validation.details)
                throw Error("No saved details about transaction" + txid);
            tg._slpValidator.cachedValidations[txid] = validation;
        });

        // Map _addresses -- Can comment out since this is reconstructed in call to "updateStatistics()"
        // addresses.forEach((item, idx) => {
        //     tg._addresses.set(item.address, {
        //         satoshis_balance: addresses[idx].satoshis_balance, 
        //         token_balance: (new BigNumber(addresses[idx].token_balance.toString())).multipliedBy(10**tg._tokenDetails.decimals)
        //     });
        // });

        // Map _lastUpdatedBlock
        tg._lastUpdatedBlock = token.lastUpdatedBlock;

        // Map _tokenUtxos
        tg._tokenUtxos = new Set(utxos.map(u => u.utxo));

        return tg;
    }
}

export interface TokenGraph {
    _tokenDetails: SlpTransactionDetails;
    _tokenStats: TokenStats;
    _tokenUtxos: Set<string>;
    _mintBatonUtxo: string;
    _nftParentId?: string;
    _graphTxns: Map<txid, GraphTxn>;
    _addresses: Map<cashAddr, AddressBalance>;    
    queueTokenGraphUpdateFrom(config: {txid: string, isParent: boolean, processUpToBlock?: number}): void;
    updateTokenGraphFrom(config: { txid: string, isParent?: boolean }): Promise<boolean|null>;
    searchForNonSlpBurnTransactions(): Promise<void>;
}

export interface AddressBalance {
    token_balance: BigNumber; 
    satoshis_balance: number;
}

export interface TokenDBObject {
    schema_version: number;
    tokenDetails: SlpTransactionDetailsDbo;
    tokenStats: TokenStats | TokenStatsDbo;
    mintBatonUtxo: string;
    lastUpdatedBlock: number;
    nftParentId?: string;
}

export interface GraphTxnDbo {
    tokenDetails: { tokenIdHex: string };
    graphTxn: GraphTxnDetailsDbo;
}

export interface UtxoDbo {
    tokenDetails: { tokenIdHex: string };
    utxo: string;
    txid: string;
    vout: number;
    address: string;
    bchSatoshis: number;
    slpAmount: Decimal128; 
}

export interface AddressBalancesDbo {
    tokenDetails: { tokenIdHex: string };
    address: cashAddr;
    satoshis_balance: number;
    token_balance: Decimal128;
}

export interface SlpTransactionDetailsDbo {
    transactionType: SlpTransactionType;
    tokenIdHex: string;
    versionType: number;
    timestamp: string|null;
    timestamp_unix: number|null;
    symbol: string;
    name: string;
    documentUri: string; 
    documentSha256Hex: string|null;
    decimals: number;
    containsBaton: boolean;
    batonVout: number|null;
    genesisOrMintQuantity: Decimal128|null;
    sendOutputs: Decimal128[]|null;
}

interface GraphTxnDetailsDbo {
    txid: string;
    details: SlpTransactionDetailsDbo;
    outputs: GraphTxnOutputDbo[];
    inputs: GraphTxnInputDbo[];
    stats?: {                                  // temporarily allow undefined
        depth: number;
        txcount: number;
        depthMap: {[key:string]: [number, number]}
    }
    blockHash: Buffer|null;
}

interface GraphTxnOutputDbo { 
    address: string;
    vout: number;
    bchSatoshis: number;
    slpAmount: Decimal128; 
    spendTxid: string | null;
    status: TokenUtxoStatus|BatonUtxoStatus;
    invalidReason: string | null;
}

interface GraphTxnInputDbo {
    txid: string;
    vout: number;
    slpAmount: Decimal128; 
    address: string;    
    bchSatoshis: number;                     // temporarily allow undefined
}

interface GraphTxn {
    isComplete?: boolean;
    details: SlpTransactionDetails;
    outputs: GraphTxnOutput[];
    inputs: GraphTxnInput[];
    stats?: {
        depth: number;
        txcount: number;
        depthMap: {[key:string]: [number, number]}
    }
    blockHash: Buffer|null;
}

interface GraphTxnOutput { 
    address: string;
    vout: number;
    bchSatoshis: number;
    slpAmount: BigNumber; 
    spendTxid: string | null;
    status: TokenUtxoStatus|BatonUtxoStatus;
    invalidReason: string | null;
 }

 interface GraphTxnInput {
    txid: string;
    vout: number;
    slpAmount: BigNumber; 
    address: string;
    bchSatoshis: number;
}

type txid = string;
type cashAddr = string;

interface TokenStats {
    block_created: number|null;
    block_last_active_send: number|null;
    block_last_active_mint: number|null;
    qty_valid_txns_since_genesis: number;
    qty_valid_token_utxos: number;
    qty_valid_token_addresses: number;
    qty_token_minted: BigNumber;
    qty_token_burned: BigNumber;
    qty_token_circulating_supply: BigNumber;
    qty_satoshis_locked_up: number;
    minting_baton_status: TokenBatonStatus;
}

interface TokenStatsDbo {
    block_created: number|null;
    block_last_active_send: number|null;
    block_last_active_mint: number|null;
    qty_valid_txns_since_genesis: number;
    qty_valid_token_utxos: number;
    qty_valid_token_addresses: number;
    qty_token_minted: Decimal128;
    qty_token_burned: Decimal128;
    qty_token_circulating_supply: Decimal128;
    qty_satoshis_locked_up: number;
    minting_baton_status: TokenBatonStatus;
}

enum TokenUtxoStatus {
    "UNSPENT" = "UNSPENT", 
    "SPENT_SAME_TOKEN" = "SPENT_SAME_TOKEN",
    "SPENT_WRONG_TOKEN" = "SPENT_WRONG_TOKEN",
    "SPENT_NOT_IN_SEND" = "SPENT_NOT_IN_SEND",
    "SPENT_NON_SLP" = "SPENT_NON_SLP",
    "SPENT_INVALID_SLP" = "SPENT_INVALID_SLP",
    "MISSING_BCH_VOUT" = "MISSING_BCH_VOUT",
    "EXCESS_INPUT_BURNED" = "EXCESS_INPUT_BURNED",
    //"UNKNOWN_UNTIL_BLOCK_SYNC" = "UNKNOWN_UNTIL_BLOCK_SYNC"  // may resolve to anything
}

enum BatonUtxoStatus {
    "BATON_UNSPENT" = "BATON_UNSPENT", 
    "BATON_SPENT_IN_MINT" = "BATON_SPENT_IN_MINT",
    "BATON_SPENT_NOT_IN_MINT" = "BATON_SPENT_NOT_IN_MINT", 
    "BATON_SPENT_NON_SLP" = "BATON_SPENT_NON_SLP",
    "BATON_SPENT_INVALID_SLP" = "BATON_SPENT_INVALID_SLP",
    "BATON_MISSING_BCH_VOUT" = "BATON_MISSING_BCH_VOUT"
}

enum TokenBatonStatus {
    "NEVER_CREATED" = "NEVER_CREATED",
    "ALIVE" = "ALIVE",
    "DEAD_BURNED" = "DEAD_BURNED",
    "DEAD_ENDED" = "DEAD_ENDED"
}

interface SpendDetails {
    status: TokenUtxoStatus;
    txid: string|null;
    invalidReason: string|null;
}

interface MintSpendDetails {
    status: BatonUtxoStatus;
    txid: string|null;
    invalidReason: string|null;
}

interface SpentTxos { 
    txid: string;
    block: number|null;
    blockHash: Buffer|null 
}
