# jsminer

Modified (https://gist.github.com/relayking/7a0c73c8a687f5af18d7e0e814be7bdc)  
Based on 21e8Miner(https://github.com/deanmlittle/21e8miner)

This is a simple miner, take it and expand on it if you wish.

This version of the miner uses https://github.com/ivmidable/secp256k1-node_fast_unsafe
a lightly modified version of secp256k1-node(https://github.com/cryptocoinjs/secp256k1-node)
that works with https://github.com/llamasoft/secp256k1_fast_unsafe.

This miner uses Bitsocket(Bitsocket.network) to listen to Bitcoin in real-time and will switch targets
if a better one shows up.

You can set the maximum difficulty of work you wish to solve, this is based
on the length of the target string. lower this number if you want to save power.
IE,
4 = 21e8, 6 = 21e800, 8 = 21e80000(default) and so on..


# Installation

git clone https://github.com/ivmidable/jsminer.git  
cd jsminer  
npm install -g node-gyp (if you don't have it installed already)  
npm install  
cd node_modules/secp256k1  
node-gyp configure  
node-gyp build  
cd ../..  

# Creating Config
node setup.js  

BACKUP your MinerID private key, the corrisponding public key you sign with will be used  
to receive Putr if you mine the correct hashes.  

# Running Miner
node manager.js
 
