// 'use strict';
var CryptoJS = require("crypto-js");
var express = require("express");
var bodyParser = require('body-parser');
var WebSocket = require("ws");
/**
 * express框架
 * 官方解释：process 对象是一个 global （全局变量），提供有关信息，控制当前 Node.js 进程。
 * 作为一个对象，它对于 Node.js 应用程序始终是可用的，故无需使用 require()。
 *  => 为function的一种方式
 */
var http_port = process.env.HTTP_PORT || 3001;
var p2p_port = process.env.P2P_PORT || 6001;
var initialPeers = process.env.PEERS ? process.env.PEERS.split(',') : [];
var sockets = [];
var MessageType = {
    QUERY_LATEST: 0,//最后一个块
    QUERY_ALL: 1,//所有块
    RESPONSE_BLOCKCHAIN: 2,//区块链新增
    RESPONSE_BLOCKCHAIN_INFO: 3,//区块链信息
    TRANSACTION:4 //交易
};

/**
 * 建立网络http,节点控制
 */
function initHttpServer() {
    var app = express();
    app.use(bodyParser.json());
    //查看目前区块链
    app.get('/blocks', (req, res) => res.send(JSON.stringify(blockchain.chain)));
    //挖矿，新增区块
    app.post('/mineBlock', (req, res) => {
        var address = req.body.address;
        //挖矿
        blockchain.minePendingTransactions(address);

        broadcast(responseLatestMsg());

        res.send();
    });
    //所有节点
    app.get('/peers', (req, res) => {
        //map() 把每个元素通过函数传递到当前匹配集合中，生成包含返回值的新的 jQuery 对象。
        res.send(sockets.map(s => s._socket.remoteAddress + ':' + s._socket.remotePort));
    });
    //增加节点
    app.post('/addPeer', (req, res) => {
        connectToPeers([req.body.peer]);
        res.send();
    });
    //增加交易
    app.post('/transaction', (req, res) => {
        var data = req.body;
        //交易
        blockchain.createTransaction(new Transaction(data.fromAddress, data.toAddress, data.amount));
        broadcast(responseLatestTransactionMsg());

        res.send();
    });

    app.listen(http_port, () => console.log('Listening http on port: ' + http_port));
}
/**
 * 建立网络webSocket,节点通讯
 */
function initP2PServer () {
    var server = new WebSocket.Server({port: p2p_port});
    server.on('connection', ws => initConnection(ws));
    console.log('listening websocket p2p port on: ' + p2p_port);
};

function  initConnection (ws)  {
    sockets.push(ws);
    initMessageHandler(ws);
    initErrorHandler(ws);
    write(ws, queryChainLengthMsg());
};
/**
 * 
 * @param {消息处理} ws 
 */
function  initMessageHandler (ws)  {
    ws.on('message', (data) => {
        var message = JSON.parse(data);
        console.log('Received message' + JSON.stringify(message));
        switch (message.type) {
            case MessageType.QUERY_LATEST:
                write(ws, responseLatestMsg());
                break;
            case MessageType.QUERY_ALL:
                write(ws, responseChainMsg());
                break;
            case MessageType.RESPONSE_BLOCKCHAIN:
                handleBlockchainResponse(message);
                break;
                case MessageType.RESPONSE_BLOCKCHAIN_INFO://将最新的区块插入本地
                handleBlockchainResponseInfo(message);
                break;
                case MessageType.TRANSACTION:
                handleTranscation(message);
                break;
        }
    });
};
//当有节点断开的时候
function initErrorHandler  (ws) {
    var closeConnection = (ws) => {
        console.log('connection failed to peer: ' + ws.url);
        sockets.splice(sockets.indexOf(ws), 1);
    };
    ws.on('close', () => closeConnection(ws));
    ws.on('error', () => closeConnection(ws));
};
//链接新节点
var connectToPeers = (newPeers) => {
    newPeers.forEach((peer) => {
        var ws = new WebSocket(peer);
        ws.on('open', () => initConnection(ws));
        ws.on('error', () => {
            console.log('connection failed')
        });
    });
};
/**
 * 网络传递(单点)
 */
function write (ws, message) {
    ws.send(JSON.stringify(message));
}
/**
 * 网络传递(广播)
 */
function broadcast (message) { 
    sockets.forEach(socket => write(socket, message));
}
var queryChainLengthMsg = () => ({'type': MessageType.QUERY_LATEST});
var queryAllMsg = () => ({'type': MessageType.QUERY_ALL});
//返回整个区块链
var responseChainMsg = () =>({
    'type': MessageType.RESPONSE_BLOCKCHAIN_INFO, 'data': JSON.stringify(blockchain.chain)
});
//返回最后一个Block
var responseLatestMsg = () => ({
    'type': MessageType.RESPONSE_BLOCKCHAIN,
    'data': JSON.stringify(blockchain.getLatestBlock())
});
//返回所有交易
var responseTransactionMsg = () => ({
    'type': MessageType.TRANSACTION,
    'data': JSON.stringify(blockchain.pendingTransactions)
});
//返回最后一个交易
var responseLatestTransactionMsg = () => ({
    'type': MessageType.TRANSACTION,
    'data': JSON.stringify(blockchain.pendingTransactions[blockchain.pendingTransactions.length -1])
});

/**
 * 交易类
 */
class Transaction{
    constructor(fromAddress, toAddress, amount){
        this.fromAddress = fromAddress;
        this.toAddress = toAddress;
        this.amount = amount;
    }
}
/**
 * 区块类
 */
class Block {
    constructor(index,timestamp, transactions, previousHash = '') {
        this.index = index;
        this.previousHash = previousHash;
        this.timestamp = timestamp;
        //交易信息
        this.transactions = transactions;
        this.hash = this.calculateHash();
        this.nonce = 0;
    }

    calculateHash() {
        return CryptoJS.SHA256(this.index + this.previousHash + this.timestamp + JSON.stringify(this.transactions) + this.nonce).toString();
    }
    //挖矿
    mineBlock(difficulty) {
        while (this.hash.substring(0, difficulty) !== Array(difficulty + 1).join("0")) {
            this.nonce++;
            this.hash = this.calculateHash();
        }
        console.log("BLOCK MINED: " + this.hash);
    }
}
/**
 * 区块链
 */
class Blockchain{
    constructor() {
        this.chain = [this.createGenesisBlock()];
        this.difficulty = 2;
        // 在区块产生之间存储交易的地方
        this.pendingTransactions = [];
        // 挖矿回报
        this.miningReward = 100;
    }

    createGenesisBlock() {
        return new Block(0,Date.parse("2018-01-01"), [], "0");
    }

    getLatestBlock() {
        return this.chain[this.chain.length - 1];
    }

    minePendingTransactions(miningRewardAddress){
        // 用所有待交易来创建新的区块并且开挖..
        let block = new Block(this.chain.length, Date.now(), this.pendingTransactions, this.getLatestBlock().hash);
        block.mineBlock(this.difficulty);

        console.log('Block successfully mined!');
        // 将新挖的看矿加入到链上
        this.chain.push(block);
        // 重置待处理交易列表并且发送奖励(将挖到的信息作为下一次挖矿的交易信息，下一次产生则这个地址获取奖励)
        this.pendingTransactions = [
            new Transaction(null, miningRewardAddress, this.miningReward)
        ];
    }
//创建新的交易
    createTransaction(transaction){
        //新增交易
        console.log("交易："+transaction);
        this.pendingTransactions.push(transaction);
    }
//根据地址处理变化的金额
    getBalanceOfAddress(address){
        let balance = 0;

        for(const block of this.chain){
            for(const trans of block.transactions){
                if(trans.fromAddress === address){
                    balance -= trans.amount;
                }

                if(trans.toAddress === address){
                    balance += trans.amount;
                }
            }
        }

        return balance;
    }

    isChainValid() {
        for (let i = 1; i < this.chain.length; i++){
            const currentBlock = this.chain[i];
            const previousBlock = this.chain[i - 1];

            if (currentBlock.hash !== currentBlock.calculateHash()) {
                return false;
            }

            if (currentBlock.previousHash !== previousBlock.hash) {
                return false;
            }
        }

        return true;
    }
}


var blockchain = new Blockchain();

/**
 * 
 * @param {验证是否为正确的区块链} chain 
 */
function isChainValid(chain) {
    
    for (let i = 1; i < chain.length; i++){
        const currentBlock =  chain[i];
        const previousBlock = chain[i - 1];
        console.log("currentBlock.hash:"+currentBlock.previousHash)
        console.log("previousBlock.hash:"+previousBlock.hash)
        calculateHash = CryptoJS.SHA256(currentBlock.index + currentBlock.previousHash + currentBlock.timestamp + JSON.stringify(currentBlock.transactions) + currentBlock.nonce).toString();
        console.log("calculateHash:"+calculateHash)
        if (currentBlock.hash !== calculateHash) {
            return false;
        }
        if (currentBlock.previousHash !== previousBlock.hash) {
            return false;
        }
    }

    return true;
}
/**
 * 
 * @param {更新网络中最新的区块} message 
 */
function handleBlockchainResponseInfo (message){
    var chain = JSON.parse(message.data);
    console.log("区块链"+chain);
    if (chain.length >1 && isChainValid(chain)) {
        blockchain.chain = chain;
    }else{

    }
}
/**
 * 
 * @param {新增区块} message 
 */
function handleBlockchainResponse (message) {
    var latestBlockReceived = JSON.parse(message.data);
    console.log("新增区块："+latestBlockReceived.index);
    //有人插入了区块
    var latestBlockHeld = blockchain.getLatestBlock();
    console.log("上一个区块："+latestBlockHeld.index);
    if (latestBlockReceived.index > latestBlockHeld.index) {
        console.log('blockchain possibly behind. We got: ' + latestBlockHeld.index + ' Peer got: ' + latestBlockReceived.index);
        if (latestBlockHeld.previousHash === latestBlockReceived.hash) {
            console.log("We can append the received block to our chain");
            blockchain.chain.push(latestBlockReceived);
            broadcast(responseLatestMsg());
        } else {
            broadcast(queryAllMsg());
        }
    } else {
        console.log('received blockchain is not longer than current blockchain. Do nothing');
    }
};
/**
 * 
 * @param {处理交易} message 
 */
function handleTranscation(message) {
    //插入新的交易
    blockchain.createTransaction(message.data);
}
/**
 * 
 * @param {更换区块链，使用较长的} newBlocks 
 */
var replaceChain = (newBlocks) => {
    if (isValidChain(newBlocks) && newBlocks.length > blockchain.length) {
        console.log('Received blockchain is valid. Replacing current blockchain with received blockchain');
        blockchain = newBlocks;
        broadcast(responseLatestMsg());
    } else {
        console.log('Received blockchain invalid');
    }
};

//初始化
connectToPeers(initialPeers);
initHttpServer();
initP2PServer();

