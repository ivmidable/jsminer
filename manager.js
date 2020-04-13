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
var work = new Map();
var workers = new Map();
var worker_hashrate = new Map();
var working = false;
var st = undefined;
var txn = undefined;
var utxo = undefined;
var address = undefined;
var sock = undefined;
var lastEventId = undefined;

//Main
(async () => {
    if (config.maxDiff === 0)
        config.maxDiff = 10000;
    address = await getAddressFromPaymail(config.payto);
    launchWorkers();
    let bs = new Date().getTime();
    connectToBitsocket();

    setTimeout(async function tick() {
        if (new Date().getTime() - bs > 300000) {
            sock.close();
            await connectToBitsocket();
            bs = new Date().getTime();
        }

        if (working === true) {
            try {
                await checkMarketMined();
            } catch (e) {
                console.log("\nfailed to fetch mined, retrying..");
            }
        } else {
            try {
            const { data } = await axios.get("https://api.whatsonchain.com/v1/bsv/main/exchangerate");
            bsvusd = Number(data.rate).toFixed(2);
            } catch(_) {
                console.log(chalk.red("Failed to update price...retrying"));
            }
        }

        printDashboard();

        let sorted = sortWork();

        if (utxo !== undefined && checkIfMined(utxo) === true) {
            console.log(chalk.yellowBright("\nno longer unmined. killing workers."));
            killWorkers();
            launchWorkers();
            address = await getAddressFromPaymail(config.payto);
        }

        if (work.size === 0) {
            setTimeout(tick, config.poll);
            return;
        }

        await mineSorted(sorted[0][1]);

        setTimeout(tick, config.poll);
    }, 0);
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
                            work.set(`${obj.data[i].tx.h}.out.${obj.data[i].out[j].i}`, { txid: obj.data[i].tx.h, i: obj.data[i].out[j].i, h: obj.data[i].out[j].h0, t: obj.data[i].out[j].h1, v: obj.data[i].out[j].e.v });
                        }
                    }
                }
            }
        }

        if (work.size === 1) {
            let top = { ...work.values().next().value };
            (async () => {
                await mineSorted(top);
            })()
        }
    }
}

//test if we can reliable delte from work.
async function checkMarketMined() {
    try {
        const { data } = await axios.get("https://pow.market/api/mined");
        bsvusd = data.bsvusd;
        for (let magic of data.magicnumbers) {
            work.delete(`${magic.txid}.out.${magic.vout}`);
        }
    } catch (e) {
        console.log(e);
    }
}

function checkIfMined(utxo) {
    return !work.has(`${utxo.txid}.out.${utxo.vout}`);
}

//sort based on easiest to mine with highest reward
function sortWork() {
    return [...work].sort((a, b) => {
        if (a[1].t.length - b[1].t.length < 0) {
            if (Number(a[1].v) > Number(b[1].v)) {
                return -1;
            }
            if (a[1].t.length < b[1].t.length) {
                return -1;
            }
            if (Number(a[1].v) < Number(b[1].v)) {
                return 1;
            }
        }
        if (a[1].t.length > b[1].t.length) {
            return 1;
        }
        return 0;
    });
}

async function mineSorted(top) {
    if (utxo !== undefined && utxo.txid !== top.txid && utxo.vout !== top.i) {
        console.log(chalk.yellowBright("\nno longer the top choice to mine. killing workers."));
        killWorkers();
        launchWorkers();
        utxo = { txid: top.txid, vout: top.i };
        address = await getAddressFromPaymail(config.payto);
        st = new Date().getTime();
        try {
            await startMining(top, address);
            working = true;
        } catch (_) {

        }
        return;
    }

    if (utxo === undefined) {
        utxo = { txid: top.txid, vout: top.i };
        st = new Date().getTime();
        try {
            await startMining(top, address);
            working = true;
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
    process.stdout.write(chalk.blue(`hash/s:${(combined / (+ new Date() - st) * 1000).toFixed(0)} bsvusd:${bsvusd} unmined:${work.size}`));
}

async function getAddressFromPaymail(paymail) {
    try {
        const polynym = await axios.get(`https://api.polynym.io/getAddress/${paymail}`);
        if (config.fallback !== undefined && config.fallback.length === 0) {
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
                    console.log(chalk.yellowBright(`\nSucceded in solving the hash. killing workers`));
                    await publish(m.data.sig, m.data.priv_key);
                    if (utxo !== undefined) {
                        work.delete(`${utxo.txid}.out.${utxo.vout}`);
                        utxo = undefined;
                    }
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
    working = false;
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
    }
}

async function startMining(from, to) {
    try {
        to = bsv.Script.buildPublicKeyHashOut(to);
    } catch (e) {
        throw ("Invalid address");
    }
    console.log(chalk.green(`\nMining TX ${from.txid} output ${from.i}`));
    console.log(chalk.green(`Pay to: ${to}`));
    let script = `${from.h} ${from.t} OP_SIZE OP_4 OP_PICK OP_SHA256 OP_SWAP OP_SPLIT OP_DROP OP_EQUALVERIFY OP_DROP OP_CHECKSIG`;
    const value = from.v;
    const targetScript = bsv.Script.fromASM(script);
    let target = from.t;

    //Make initial TX
    let tx = new Transaction();
    tx.addInput(
        new Transaction.Input({
            output: new Transaction.Output({
                script: targetScript,
                satoshis: value
            }),
            prevTxId: from.txid,
            outputIndex: from.i,
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
