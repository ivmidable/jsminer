//Includes
const axios = require('axios');
const bsv = require('bsv');
const { fork } = require("child_process");
const EventSource = require("eventsource");
const chalk = require('chalk');
const config = require('./config');

//Const
const PrivateKey = bsv.PrivateKey;
const Transaction = bsv.Transaction;
const sigtype = bsv.crypto.Signature.SIGHASH_ALL | bsv.crypto.Signature.SIGHASH_FORKID;
const flags = bsv.Script.Interpreter.SCRIPT_VERIFY_MINIMALDATA | bsv.Script.Interpreter.SCRIPT_ENABLE_SIGHASH_FORKID | bsv.Script.Interpreter.SCRIPT_ENABLE_MAGNETIC_OPCODES | bsv.Script.Interpreter.SCRIPT_ENABLE_MONOLITH_OPCODES;
const minerPriv = new PrivateKey.fromWIF(config.minerId.privKey);
const minerPub = new bsv.PublicKey.fromPrivateKey(minerPriv).toString('hex');

//Variables
var bsvusd = 0;
var unmined = [];
var mined = [];
var incoming = [];
var incoming_synced = 0;
var workers = new Map();
var worker_hashrate = new Map();
var st = undefined;
var txn = undefined;
var utxo = undefined;
var address = undefined;
var sock = undefined;
var lastEventId = undefined;

//Main
(async () => {
    if(config.maxDiff === 0)
        config.maxDiff = 10000;
    address = await getAddressFromPaymail(config.payto);
    launchWorkers();
    let bs = new Date().getTime();
    connectToBitsocket();

    //sometimes pow.market is down, if you KNOW the hash is mined you can blacklist it.
    //mined.push({txid:"874dadad92909573c328b3db6730342899414958b12ac1e132a7c2b4b975c90b", vout:3});

    setTimeout(async function tick() {
        if (new Date().getTime() - bs > 300000) {
            sock.close();
            if (incoming_synced === incoming.length) {
                incoming = [];
                incoming_synced = 0;
            }
            await connectToBitsocket();
        }
        syncIncomingUnmined();
        try {
            await filterMarketMined();
        } catch (e) {
            console.log("\nfailed to fetch mined, retrying..");
        }
        filterLocalMined();

        printDashboard();

        sortUnmined();

        if (utxo !== undefined && checkIfMined(utxo) === true) {
            console.log("\nno longer unmined. killing signers.");
            killWorkers();
            launchWorkers();
            address = await getAddressFromPaymail(config.payto);
        }

        if (unmined.length === 0) {
            setTimeout(tick, config.poll);
            return;
        }

        await mineSorted();

        setTimeout(tick, config.poll);
    }, config.poll);
})();

//Functions
async function connectToBitsocket() {
    const b64 = Buffer.from(JSON.stringify({
        "v": 3,
        "q": {
            "find": {
                "out.o2": "OP_SIZE",
                "out.o3": "OP_4",
                "out.o4": "OP_PICK",
                "out.o5": "OP_SHA256",
                "out.o6": "OP_SWAP",
                "out.o7": "OP_SPLIT",
                "out.o8": "OP_DROP",
                "out.o9": "OP_EQUALVERIFY",
                "out.o10": "OP_DROP",
                "out.o11": "OP_CHECKSIG",
                "out.len": 12
            },
            "project": {
                "tx.h": 1,
                "out": 1
            }
        }
    })).toString("base64")
    // Subscribe
    if (lastEventId !== undefined) {
        sock = new EventSource('https://txo.bitsocket.network/s/' + b64, { headers: { "Last-Event-Id": lastEventId } })
    } else {
        sock = new EventSource('https://txo.bitsocket.network/s/' + b64);
    }
    sock.onmessage = function (e) {
        if (e.lastEventId !== "undefined" && lastEventId !== e.lastEventId) {
            lastEventId = e.lastEventId;
            let obj = JSON.parse(e.data);
            for (let i = 0; i < obj.data.length; i++) {
                for (let j = 0; j < obj.data[i].out.length; j++) {
                    if (is21e8Out(obj.data[i].out[j])) {
                        if (obj.data[i].out[j].h1.length <= config.maxDiff) {
                            incoming.push({ txid: obj.data[i].tx.h, out: obj.data[i].out[j] });
                        }
                    }
                }
            }
        }
        if (incoming.length !== 0 && unmined.length === 0) {
            unmined = [...incoming];
            sortUnmined();
            (async () => {
                await mineSorted();
            })()
        }
    }
}

function syncIncomingUnmined() {
    let found = false;
    let temp = [...incoming];
    /*if(temp.length === 0) {
        incoming_synced = 0;
    } else {*/
    let i = 0;
    for (i = incoming_synced; i < temp.length; i++) {
        for (let j = 0; j < unmined.length; j++) {
            if (temp[i].txid === unmined[j].txid && temp[i].out.i === unmined[j].out.i) {
                found = true;
                break;
            }
        }
        if (found === false) {
            unmined.push(temp[i]);
        }
        found = false;
    }
    incoming_synced = i;
    //}
}

async function filterMarketMined() {
    let out = [];
    let found = false;
    try {
        const { data } = await axios.get('https://pow.market/api/mined');
        bsvusd = data.bsvusd;
        for (let i = 0; i < unmined.length; i++) {
            for (let j = 0; j < data.magicnumbers.length; j++) {
                if (unmined[i].txid === data.magicnumbers[j].txid) {
                    if (unmined[i].out.i === data.magicnumbers[j].vout) {
                        found = true;
                        break;
                    }
                }
            }
            if (found === false) {
                out.push(unmined[i]);
            }
            found = false;
        }
        unmined = out;
    } catch (e) {
        console.log(e);
    }
}

function filterLocalMined() {
    let temp = [];
    let found = false;
    for (let i = 0; i < unmined.length; i++) {
        for (let j = 0; j < mined.length; j++) {
            if(unmined[i] === undefined || mined[j] === undefined) {
                return;
            }
            if (unmined[i].txid === mined[j].txid && unmined[i].out.i === mined[j].vout) {
                found = true;
                break;
            }
        }
        if (found === false) {
            temp.push(unmined[i]);
        }
        found = false;
    }
    unmined = temp;
}

function checkIfMined(utxo) {
    for (let i = 0; i < unmined.length; i++) {
        if (utxo.txid === unmined[i].txid && utxo.vout === unmined[i].out.i)
            return false;
    }
    return true;
}

//sort based on easiest to mine with highest reward
function sortUnmined() {
    unmined.sort((a, b) => {
        if (a.out.h1.length - b.out.h1.length <= 0) {
            if (Number(a.out.e.v) > Number(b.out.e.v)) {
                return -1;
            }
            if (a.out.h1.length < b.out.h1.length) {
                return -1;
            }
            if (Number(a.out.e.v) < Number(b.out.e.v)) {
                return 1;
            }
        }
        if (a.out.h1.length > b.out.h1.length) {
            return 1;
        }
        return 0;
    });
}

async function mineSorted() {
    if (utxo !== undefined && (utxo.txid !== unmined[0].txid || utxo.vout !== unmined[0].out.i)) {
        console.log("\nno longer the top choice to mine. killing workers.");
        killWorkers();
        launchWorkers();
        utxo = { txid: unmined[0].txid, vout: unmined[0].out.i };
        address = await getAddressFromPaymail(config.payto);
        st = new Date().getTime();
        try {
            await startMining(unmined[0], address);
        } catch (_) {

        }
        return;
    }

    if (utxo === undefined) {
        utxo = { txid: unmined[0].txid, vout: unmined[0].out.i };
        st = new Date().getTime();
        try {
            await startMining(unmined[0], address);
        } catch (_) {

        }
    }
}

function printDashboard() {
    let combined = 0;
    for (let rate of worker_hashrate.keys()) {
        combined += worker_hashrate.get(rate);
    }
    process.stdout.clearLine();
    process.stdout.cursorTo(0);
    process.stdout.write(chalk.blue(`hash/s:${(combined / (+ new Date() - st) * 1000).toFixed(0)} bsvusd:${bsvusd} unmined:${unmined.length}`));
}

async function getAddressFromPaymail(paymail) {
    try {
         
        const polynym = await axios.get(`https://api.polynym.io/getAddress/${paymail}`);
        if(config.fallback !== undefined && config.fallback.length === 0) {
            config.fallback = polynym.data.address;
        }
        console.log(`\n${polynym.data.address}`);
        return polynym.data.address;
    } catch (e) {
        console.log(`\nusing fallback: ${config.fallback}`);
        return config.fallback;
    }
}

function is21e8Out(data) {
    return !!(
        data.o2 === "OP_SIZE" &&
        data.o3 === "OP_4" &&
        data.o4 === "OP_PICK" &&
        data.o5 === "OP_SHA256" &&
        data.o6 === "OP_SWAP" &&
        data.o7 === "OP_SPLIT" &&
        data.o8 === "OP_DROP" &&
        data.o9 === "OP_EQUALVERIFY" &&
        data.o10 === "OP_DROP" &&
        data.o11 === "OP_CHECKSIG" &&
        data.len === 12
    );
}

function launchWorkers() {
    for (let i = workers.size; i < config.spawn; i++) {
        console.log("launched worker");
        let f = fork('./worker.js', [], { serialization: "advanced" });
        workers.set(f.pid, { proc: f });

        f.on("message", async (m) => {
            switch (m.state) {
                case 'hash_count':
                    worker_hashrate.set(f.pid, m.data);
                    break;
                case 'success':
                    console.log(`\nSucceded in solving the hash.`);
                    await publish(m.data.sig, m.data.priv_key);
                    mined.push(utxo);
                    utxo = undefined;
                    killWorkers();
                    launchWorkers();
                    address = await getAddressFromPaymail(config.payto);
                    break;
                default:
                    break;
            }
        });
    }
}

function startWorking(hashbuf, target) {
    for (let worker of workers.keys()) {
        workers.get(worker).proc.send({ state: "start", data: { hashbuf: hashbuf, target: target } });
    }
}

function killWorkers() {
    for (let worker of workers.keys()) {
        try {
            process.kill(worker);
        } catch (_) {
            console.log("already dead.");
        }
    }
    workers.clear();
    worker_hashrate.clear();
    utxo = undefined;
}

async function publish(sig, priv_key) {
    priv_key = PrivateKey.fromWIF(priv_key);
    const unlockingScript = new bsv.Script({});
    unlockingScript
        .add(
            Buffer.concat([
                sig,
                Buffer.from([sigtype & 0xff])
            ])
        )
        .add(priv_key.toPublicKey().toBuffer());
    txn.inputs[0].setScript(unlockingScript);
    console.log(chalk.yellow(unlockingScript.toString()))

    if (!!config.autopublish) {
        try {
            console.log(chalk.cyan(txn.uncheckedSerialize()))
            //const { data } = await axios.post('https://api.whatsonchain.com/v1/bsv/main/tx/raw', { txhex: txn.uncheckedSerialize() });
            const { data } = await axios.get(`https://bsvbook.guarda.co/api/v2/sendtx/${txn.uncheckedSerialize()}`);
            console.log(chalk.green('\nPublished ' + Buffer.from(txn._getHash()).reverse().toString('hex')));
        } catch (e) {
            console.log(chalk.red(e));
        }
    } else {
        return;
    }
}

async function startMining(from, to) {
    try {
        to = bsv.Script.buildPublicKeyHashOut(to);
    } catch (e) {
        throw ("Invalid address");
    }
    console.log(chalk.green(`\nMining TX ${utxo.txid} output ${utxo.vout}`));
    console.log(chalk.green(`Pay to: ${to}`));
    let script = `${from.out.h0} ${from.out.h1} OP_SIZE OP_4 OP_PICK OP_SHA256 OP_SWAP OP_SPLIT OP_DROP OP_EQUALVERIFY OP_DROP OP_CHECKSIG`;
    const value = from.out.e.v;
    const targetScript = bsv.Script.fromASM(script);
    let target = from.out.h1;

    //Make initial TX
    let tx = new Transaction();
    tx.addInput(
        new Transaction.Input({
            output: new Transaction.Output({
                script: targetScript,
                satoshis: value
            }),
            prevTxId: from.txid,
            outputIndex: from.out.i,
            script: bsv.Script.empty()
        })
    );

    tx.addOutput(
        new Transaction.Output({
            satoshis: (config.minerId.enabled && config.minerId.minValue < value) ? value - 300 : value - 100,
            script: to
        })
    );

    if (config.minerId.enabled && config.minerId.minValue < value) {
        const schema = {
            id: minerPub,
            sig: bsv.crypto.ECDSA.sign(Buffer.from(from.txid, 'hex'), minerPriv).toString('hex'),
            message: config.minerId.message
        };
        tx.addOutput(new Transaction.Output({
            script: bsv.Script.buildSafeDataOut(JSON.stringify(schema)),
            satoshis: 0
        }));
    }

    console.log(chalk.green(`Targeting: ${target}`));

    const sighash = Transaction.sighash.sighash(tx, sigtype, 0, tx.inputs[0].output.script, new bsv.crypto.BN(tx.inputs[0].output.satoshis), flags).reverse();
    startWorking(sighash, target);
    txn = tx;
}
