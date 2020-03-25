const bsv = require('bsv');
const secp256k1 = require('secp256k1');
const crypto = require('crypto');

var mk_priv_Key = undefined;
var priv_key = undefined;
var hashbuf = undefined;
var target = undefined;
var sig256 = undefined;
var sig = undefined;
var hash_count = 0;
var cur_time = undefined;
var prev_time = new Date().getTime();

var sigtype = bsv.crypto.Signature.SIGHASH_ALL | bsv.crypto.Signature.SIGHASH_FORKID;
var sigtypeBuffer = undefined;

function makePrivateKey() {
    do {
        mk_priv_Key = crypto.randomBytes(32)
    } while (!secp256k1.privateKeyVerify(mk_priv_Key))
    return mk_priv_Key;
}

function sha256(data) {
    return crypto.createHash('sha256').update(data).digest('hex')
}


function work() {
    priv_key = makePrivateKey();
    sig = secp256k1.signatureExport(secp256k1.signatureNormalize(secp256k1.ecdsaSign(hashbuf, priv_key).signature));
    hash_count++;
    sig256 = sha256(Buffer.concat([sig, Buffer.from(sigtype, 'hex')]));
    if (sig256.startsWith(target)) {
        return true;
    }
    return false;
}

function start() {
    while (!work()) {
        cur_time = new Date().getTime();
        if (cur_time - prev_time > 5000) {
            process.send({ state: 'hash_count', data: hash_count });
            prev_time = cur_time;
        }
    }
    let key = new bsv.PrivateKey(bsv.crypto.BN.fromBuffer(priv_key), 'livenet');
    process.send({ state: "success", data: { sig: sig, priv_key: key.toWIF() } });
}

function setup() {
    sigtype = sigtype.toString(16);
    sigtypeBuffer = Buffer.from(sigtype, 'hex');
    process.on('message', (m) => {
        switch (m.state) {
            case "start":
                hashbuf = m.data.hashbuf;
                target = m.data.target;
                start();
                break;
            default:
                break;
        }
    });
}

//keep alive
setInterval(() => { }, 1 << 30);
setup();