'use strict';

var _interopRequireDefault = require('@babel/runtime/helpers/interopRequireDefault');

Object.defineProperty(exports, '__esModule', {
  value: true,
});
Object.defineProperty(exports, 'AddressTypes', {
  enumerable: true,
  get: function () {
    return _address_types.default;
  },
});
exports.Init = void 0;
Object.defineProperty(exports, 'Mnemonic', {
  enumerable: true,
  get: function () {
    return _bitcoreMnemonic.default;
  },
});
Object.defineProperty(exports, 'OutputTypes', {
  enumerable: true,
  get: function () {
    return _output_types.default;
  },
});
exports.WalletFile = exports.SetBackendDb = void 0;
Object.defineProperty(exports, 'bitcore', {
  enumerable: true,
  get: function () {
    return _bitcoreLib.default;
  },
});
exports.xNavBootstrap = exports.electrumMnemonic = void 0;

var crypto = _interopRequireWildcard(require('crypto'));

var Db = _interopRequireWildcard(require('./db/index.js'));

var events = _interopRequireWildcard(require('events'));

var _list = _interopRequireDefault(require('./utils/list.js'));

var _bitcoreMnemonic = _interopRequireDefault(
  require('@aguycalled/bitcore-mnemonic'),
);

var electrumMnemonic = _interopRequireWildcard(require('electrum-mnemonic'));

var _electrumMnemonic = electrumMnemonic;
exports.electrumMnemonic = electrumMnemonic;

var _bitcoreLib = _interopRequireDefault(require('@aguycalled/bitcore-lib'));

var _electrumClientJs = _interopRequireDefault(
  require('@aguycalled/electrum-client-js'),
);

var _lodash = _interopRequireDefault(require('lodash'));

var _bitcoreMessage = _interopRequireDefault(
  require('@aguycalled/bitcore-message'),
);

var _index2 = _interopRequireDefault(require('./nodes/index.js'));

var _queue = _interopRequireDefault(require('./utils/queue.js'));

var _output_types = _interopRequireDefault(require('./utils/output_types.js'));

var _address_types = _interopRequireDefault(
  require('./utils/address_types.js'),
);

var constants = _interopRequireWildcard(require('./utils/constants'));

var _hash = require('@aguycalled/bitcore-lib/lib/crypto/hash');

var _xNavBootstrap = _interopRequireWildcard(require('./xnav_bootstrap.js'));

exports.xNavBootstrap = _xNavBootstrap;

function _getRequireWildcardCache(nodeInterop) {
  if (typeof WeakMap !== 'function') return null;
  var cacheBabelInterop = new WeakMap();
  var cacheNodeInterop = new WeakMap();
  return (_getRequireWildcardCache = function (nodeInterop) {
    return nodeInterop ? cacheNodeInterop : cacheBabelInterop;
  })(nodeInterop);
}

function _interopRequireWildcard(obj, nodeInterop) {
  if (!nodeInterop && obj && obj.__esModule) {
    return obj;
  }
  if (obj === null || (typeof obj !== 'object' && typeof obj !== 'function')) {
    return { default: obj };
  }
  var cache = _getRequireWildcardCache(nodeInterop);
  if (cache && cache.has(obj)) {
    return cache.get(obj);
  }
  var newObj = {};
  var hasPropertyDescriptor =
    Object.defineProperty && Object.getOwnPropertyDescriptor;
  for (var key in obj) {
    if (key !== 'default' && Object.prototype.hasOwnProperty.call(obj, key)) {
      var desc = hasPropertyDescriptor
        ? Object.getOwnPropertyDescriptor(obj, key)
        : null;
      if (desc && (desc.get || desc.set)) {
        Object.defineProperty(newObj, key, desc);
      } else {
        newObj[key] = obj[key];
      }
    }
  }
  newObj.default = obj;
  if (cache) {
    cache.set(obj, newObj);
  }
  return newObj;
}

const p2p = require('@aguycalled/bitcore-p2p').Pool;

let db = Db['Dexie'].default;

const asyncFilter = async (arr, predicate) =>
  Promise.all(arr.map(predicate)).then((results) =>
    arr.filter((_v, index) => results[index]),
  );

const Init = async () => {
  await blsct.Init();
};

exports.Init = Init;

const SetBackendDb = (backend) => {
  db = backend;
};

exports.SetBackendDb = SetBackendDb;
const blsct = _bitcoreLib.default.Transaction.Blsct;
const ripemd160 = _bitcoreLib.default.crypto.Hash.ripemd160;
const sha256 = _bitcoreLib.default.crypto.Hash.sha256;

function msleep(n) {
  return new Promise((resolve) => setTimeout(resolve, n));
}

async function sleep(n) {
  await msleep(n * 1000);
}

class WalletFile extends events.EventEmitter {
  constructor(options) {
    super();
    options = options || {};
    this.file = options.file;
    this.type = options.type || 'navcoin-js-v1';
    this.mnemonic = options.mnemonic;
    this.spendingPassword = options.spendingPassword;
    this.secret = options.password || 'secret navcoinjs';
    this.zapwallettxes = options.zapwallettxes || false;
    this.log = options.log || false;
    this.dbBackend = options.dbBackend || Db['Dexie'].default;
    this.indexedDB = options.indexedDB;
    this.IDBKeyRange = options.IDBKeyRange;
    this.queue = new _queue.default(options.queueSize);
    this.p2pPool = undefined;
    this.queue.on('progress', (progress, pending, total) => {
      this.emit('sync_status', progress, pending, total);
    });
    this.queue.on('end', async () => {
      if (
        (await this.GetPoolSize(_address_types.default.XNAV)) <
        this.GetMinPoolSize()
      ) {
        this.Log('Need to fill the xNAV key pool');
        await this.xNavFillKeyPool(
          this.spendingPassword,
          this.GetMinPoolSize() * 2,
        );
      } else {
        this.spendingPassword = '';
        this.emit('sync_finished');
      }
    });
    this.queue.on('started', () => {
      this.emit('sync_started');
    });
    this.network = options.network || 'mainnet';
    this.db = new this.dbBackend();
    this.db.on('db_load_error', (e) => {
      this.emit('db_load_error', e);
      this.Disconnect();
    });
    this.db.on('db_open', () => {
      this.emit('db_open');
    });
    this.db.on('db_closed', () => {
      this.emit('db_closed');
      this.Disconnect();
    });
  }

  async InitDb() {
    let options =
      arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : {};
    await this.db.Open(
      this.file,
      this.secret,
      this.indexedDB,
      this.IDBKeyRange,
    );
    delete this.secret;
  }

  CloseDb() {
    this.removeAllListeners();
    this.db.Close();
  }

  static async ListWallets() {
    return await db.ListWallets();
  }

  static async SetBackend(indexedDB, IDBKeyRange) {
    return await db.SetBackend(indexedDB, IDBKeyRange);
  }

  static async RemoveWallet(filename) {
    return await db.RemoveWallet(filename);
  }

  async GetPoolSize(type, change) {
    return await this.db.GetPoolSize(type, change);
  }

  GetMinPoolSize() {
    return this.minPoolSize || 10;
  }

  Log(str) {
    if (!this.log) return;
    console.log(' [navcoin-js] '.concat(str));
  }

  async Load(options) {
    var _await$this$db$GetSta;

    if (!this.db) throw new Error('DB did not load.');
    await this.InitDb();
    options = options || {};
    this.daoConsultations = {};
    this.daoProposals = {};
    this.minPoolSize = options.minPoolSize;
    this.useP2p = options.useP2p === undefined ? true : options.useP2p;
    if (!this.db.open) throw new Error('DB did not load.');
    let network = await this.db.GetValue('network');

    if (!network) {
      await this.db.SetValue('network', this.network);
    } else {
      this.network = network;
    }

    if (!(await this.db.GetValue('masterPubKey'))) {
      await this.db.SetValue('walletType', this.type);
      let mnemonic = this.mnemonic;

      if (!this.mnemonic) {
        this.newWallet = true;
        mnemonic = new _bitcoreMnemonic.default().toString();
        this.emit('new_mnemonic', mnemonic);
      }

      await this.db.AddMasterKey('mnemonic', mnemonic, this.spendingPassword);

      if (this.type === 'watch' && options.watch) {
        await this.ImportWatchAddress(options.watch);
        let masterKey = await new _bitcoreMnemonic.default(
          mnemonic,
        ).toHDPrivateKeyAsync('', this.network);
        await this.SetMasterKey(masterKey, this.spendingPassword);
      } else if (this.type === 'next') {
        let value = Buffer.from(
          new _bitcoreMnemonic.default(mnemonic).toString(),
        );

        let hash = _bitcoreLib.default.crypto.Hash.sha256(value);

        let bn = _bitcoreLib.default.crypto.BN.fromBuffer(hash);

        let pk = new _bitcoreLib.default.PrivateKey(bn);
        await this.ImportPrivateKey(pk, this.spendingPassword);
        let masterKey = await new _bitcoreMnemonic.default(
          mnemonic,
        ).toHDPrivateKeyAsync('', this.network);
        await this.SetMasterKey(masterKey, this.spendingPassword);
      } else if (this.type === 'navcoin-core') {
        let keyMaterial = _bitcoreMnemonic.default.mnemonicToData(mnemonic);

        await this.SetMasterKey(keyMaterial, this.spendingPassword);
      } else if (this.type === 'navcash') {
        let masterKey = _bitcoreLib.default.HDPrivateKey.fromSeed(
          await electrumMnemonic.mnemonicToSeed(mnemonic, {
            prefix: electrumMnemonic.PREFIXES.standard,
          }),
        );

        await this.SetMasterKey(masterKey, this.spendingPassword);
      } else {
        let masterKey = await new _bitcoreMnemonic.default(
          mnemonic,
        ).toHDPrivateKeyAsync('', this.network);
        await this.SetMasterKey(masterKey, this.spendingPassword);
      }

      if (options.bootstrap) {
        let bootstrap = options.bootstrap[this.network]
          ? options.bootstrap[this.network]
          : options.bootstrap;

        for (let i in bootstrap) {
          bootstrap[i].hash = bootstrap[i].txidkeys;
          delete bootstrap[i].txidkeys;
        }

        await this.db.BulkRawInsert(bootstrap);
      }
    }

    this.type = (await this.db.GetValue('walletType')) || 'navcoin-js-v1';
    this.electrumNodes =
      options.nodes && options.nodes[this.network]
        ? options.nodes[this.network]
        : _index2.default[this.network];

    if (!this.electrumNodes.length) {
      throw new Error('Wrong network');
    }

    this.electrumNodeIndex = Math.floor(
      Math.random() * this.electrumNodes.length,
    );
    this.mvk = await this.GetMasterViewKey();
    this.firstSynced = {};
    this.firstSyncCompleted = false;
    this.creationTip = undefined;
    this.failedConnections = 0;
    let creationTipDb = await this.db.GetValue('creationTip');

    if (creationTipDb) {
      this.creationTip = creationTipDb;
    } else if (options.syncFromBlock) {
      this.creationTip = options.syncFromBlock;
      await this.db.SetValue('creationTip', this.creationTip);
    }

    if (await this.GetMasterKey('nav', this.spendingPassword)) {
      await this.xNavFillKeyPool(this.spendingPassword, this.GetMinPoolSize());
      await this.NavFillKeyPool(this.spendingPassword, this.GetMinPoolSize());
    }

    if (
      this.newWallet ||
      ((_await$this$db$GetSta = await this.db.GetStakingAddresses()) === null ||
      _await$this$db$GetSta === void 0
        ? void 0
        : _await$this$db$GetSta.length) == 0
    ) {
      let pool =
        this.network == 'mainnet'
          ? 'NfLgDYL4C3KKXDS8tLRAFM7spvLykV8v9A'
          : 'n3uJuww32YGUbsoywpmG1LmgVQYMsg5Ace';
      await this.AddStakingAddress(pool, undefined, false);
      await this.db.AddLabel(pool, 'NavCash Pool');
    }

    this.poolFilled = true;
    this.mnemonic = '';
    let forceZap = false;
    if (
      (await this.db.GetUtxos(true)).length > 0 &&
      (await this.db.GetTxs()).length == 0
    )
      forceZap = true;

    if (this.zapwallettxes || forceZap) {
      await this.db.ZapWalletTxes();
    }

    this.emit('loaded');
  }

  async xNavFillKeyPool(spendingPassword) {
    let count =
      arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : 10;
    let mk = await this.GetMasterKey('xNavSpend', spendingPassword);
    if (!mk) return;
    let filled = 0;

    while ((await this.GetPoolSize(_address_types.default.XNAV)) < count) {
      filled++;
      await this.xNavCreateSubaddress(spendingPassword);
    }

    if (this.poolFilled && filled > 0) {
      this.Log('xNAV pool was filled with ' + filled + ' new keys. Resyncing.');
      await this.SyncScriptHash(
        Buffer.from(
          _bitcoreLib.default.crypto.Hash.sha256(
            _bitcoreLib.default.Script.fromHex('51').toBuffer(),
          ).reverse(),
        ).toString('hex'),
        undefined,
        true,
      );
    }
  }

  async NavFillKeyPool(spendingPassword) {
    let count =
      arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : 10;
    if (this.type === 'next' || this.type == 'watch') return;
    let mk = await this.GetMasterKey('nav', spendingPassword);
    if (!mk) return;
    let filled = 0;

    while ((await this.GetPoolSize(_address_types.default.NAV)) < count) {
      filled++;
      await this.NavCreateAddress(spendingPassword);
    }

    if (this.type == 'navcash' || this.type == 'navcoin-core') {
      while ((await this.GetPoolSize(_address_types.default.NAV, 1)) < count) {
        filled++;
        await this.NavCreateAddress(spendingPassword, 1);
      }
    }

    this.Log('NAV pool was filled with ' + filled + ' new keys.');
  }

  async xNavReceivingAddresses() {
    let all =
      arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : true;
    return await this.db.GetXNavReceivingAddresses(all);
  }

  async NavReceivingAddresses() {
    let all =
      arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : true;
    return await this.db.GetNavReceivingAddresses(all);
  }

  async GetAllAddresses() {
    let ret = {
      spending: {
        public: {},
        private: {},
      },
      staking: {},
    };
    let receiving = await this.db.GetNavReceivingAddresses(true);

    for (let i in receiving) {
      let address = receiving[i];
      ret.spending.public[address.address] = {
        balances: await this.GetBalance(address.address),
        used: address.used,
      };
      let label = await this.db.GetLabel(address.address);
      if (label != address.address)
        ret.spending.public[address.address].label = label;
    }

    let xnav = await this.db.GetXNavReceivingAddresses(true);

    for (let i in xnav) {
      let address = xnav[i];
      ret.spending.private[address.address] = {
        balances: await this.GetBalance(address.hash),
        used: address.used,
      };
      let label = await this.db.GetLabel(address.address);
      if (label != address.address)
        ret.spending.private[address.address].label = label;
    }

    let staking = await this.db.GetStakingAddresses();

    for (let j in staking) {
      let address = staking[j];
      ret.staking[address.address] = {
        staking: (await this.GetBalance(address.address)).staked,
      };
      let label = await this.db.GetLabel(address.address);
      if (label != address.address) ret.staking[address.address].label = label;
    }

    return ret;
  }

  async NavGetPrivateKeys(spendingPassword, address) {
    let list = address
      ? [await this.db.GetNavAddress(address)]
      : await this.db.GetNavReceivingAddresses(true);

    for (let i in list) {
      list[i].privateKey = (
        await this.GetPrivateKey(list[i].hash, spendingPassword)
      ).toWIF();
      delete list[i].value;
    }

    return list;
  }

  async GetMasterKey(key, password) {
    if (!this.db) return undefined;
    let privK = await this.db.GetMasterKey('nav', password);
    if (!privK) return undefined;
    return privK;
  }

  async GetMasterSpendKey(key) {
    if (!this.db) return undefined;
    let privK = await this.db.GetMasterKey('xNavSpend', key);
    if (!privK) return undefined;
    return blsct.mcl.deserializeHexStrToFr(privK);
  }

  async GetMasterViewKey() {
    if (!this.db) return undefined;
    let pubK = await this.db.GetValue('masterViewKey');
    if (!pubK) return undefined;
    return blsct.mcl.deserializeHexStrToFr(pubK);
  }

  async xNavCreateSubaddress(sk) {
    let acct =
      arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : 0;
    let masterViewKey = this.mvk;
    let masterSpendKey = await this.GetMasterSpendKey(sk);
    if (!masterSpendKey) return;
    let index = 0;
    let dbLastIndex = await this.db.GetCounter('xNav' + acct);
    index = dbLastIndex || index;
    let { viewKey, spendKey } = blsct.DerivePublicKeys(
      masterViewKey,
      masterSpendKey,
      acct,
      index,
    );
    let hashId = new Buffer(ripemd160(sha256(spendKey.serialize()))).toString(
      'hex',
    );
    await this.db.UpdateCounter('xNav' + acct, index + 1);

    try {
      await this.db.AddKey(
        hashId,
        [acct, index],
        _address_types.default.XNAV,
        blsct.KeysToAddress(viewKey, spendKey).toString(),
        false,
        false,
        acct + '/' + parseInt(index),
      );
    } catch (e) {
      console.log(e.message);
    }
  }

  async NavCreateAddress(sk) {
    let change =
      arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : 0;
    if (this.type === 'next') return;
    let mk = await this.GetMasterKey('nav', sk);
    if (!mk) return;
    let labelCounter =
      change == 2 ? 'NavVote' : change == 1 ? 'NavChange' : 'Nav';
    let dbLastIndex = await this.db.GetCounter(labelCounter);
    let index = dbLastIndex || 0;
    let path = "m/44'/130'/0'/" + change + '/' + index;
    let privK;

    if (this.type === 'next') {
      if (index === 0 && !change) {
        index++;
      }

      path = 'm/' + change + '/' + index;
      privK = _bitcoreLib.default.HDPrivateKey(mk).deriveChild(path);
    } else if (this.type === 'navcash') {
      path = 'm/' + change + '/' + index;
      privK = _bitcoreLib.default.HDPrivateKey(mk).deriveChild(path);
    } else if (this.type === 'navcoin-js-v1') {
      privK = _bitcoreLib.default.HDPrivateKey(mk).deriveChild(path);
    } else if (this.type === 'navpay') {
      path = "m/44'/0'/0'/" + change + '/' + index;
      privK = _bitcoreLib.default.HDPrivateKey(mk).deriveChild(path);
    } else if (this.type === 'navcoin-core') {
      path = "m/0'/" + change + "'/" + index + "'";
      privK = _bitcoreLib.default.HDPrivateKey(mk).deriveChild(path);
    }

    let pk = privK.publicKey;
    let hashId = new Buffer(ripemd160(sha256(pk.toBuffer()))).toString('hex');

    let addrStr = _bitcoreLib.default.Address(pk, this.network).toString();

    await this.db.UpdateCounter(labelCounter, index + 1);

    try {
      await this.db.AddKey(
        hashId,
        privK.toString(),
        _address_types.default.NAV,
        addrStr,
        false,
        change,
        path,
        sk,
      );
    } catch (e) {
      console.log(e.message);
    }

    if (this.poolFilled) {
      await this.SyncScriptHash(this.AddressToScriptHash(addrStr));
    }
  }

  async ImportPrivateKey(privK, key) {
    if (_lodash.default.isString(privK)) {
      return this.ImportPrivateKey(
        _bitcoreLib.default.PrivateKey.fromWIF(privK),
        key,
      );
    }

    let path = 'imported';
    let pk = privK.publicKey;
    let hashId = new Buffer(ripemd160(sha256(pk.toBuffer()))).toString('hex');

    try {
      await this.db.AddKey(
        hashId,
        privK.toString(),
        _address_types.default.NAV,
        _bitcoreLib.default.Address(pk, this.network).toString(),
        false,
        false,
        path,
        key,
      );
    } catch (e) {
      console.log(e.message);
    }

    if (this.connected) {
      await this.Sync();
    }
  }

  async ImportWatchAddress(address, key) {
    if (_lodash.default.isString(address)) {
      return this.ImportWatchAddress(_bitcoreLib.default.Address(address), key);
    }

    let path = 'watch';
    let pk = address;
    let hashId = pk.toObject().hash;

    try {
      await this.db.AddKey(
        hashId,
        address.toString(),
        _address_types.default.NAV,
        _bitcoreLib.default.Address(pk, this.network).toString(),
        false,
        false,
        path,
        key,
      );
    } catch (e) {
      console.log(e.message);
    }

    if (this.connected) {
      await this.Sync();
    }
  }

  async SetTip(height) {
    this.lastBlock = height;
    this.emit('new_block', height);
    await this.db.SetValue('ChainTip', height);
  }

  async GetTip() {
    return (await this.db.GetValue('ChainTip')) || -1;
  }

  AddressToScriptHash(address) {
    return this.ScriptToScriptHash(
      _bitcoreLib.default.Script.fromAddress(address),
    );
  }

  ScriptToScriptHash(script) {
    return Buffer.from(
      _bitcoreLib.default.crypto.Hash.sha256(script.toBuffer()).reverse(),
    ).toString('hex');
  }

  async ResolveName(name) {
    let subdomains =
      arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : false;

    try {
      return this.client.blockchain_dotnav_resolveName(name, subdomains);
    } catch (e) {
      console.log('ResolveName', e);
      await this.ManageElectrumError(e);
      return await this.ResolveName(name, subdomains);
    }
  }

  async GetScriptHashes() {
    let stakingAddress =
      arguments.length > 0 && arguments[0] !== undefined
        ? arguments[0]
        : undefined;
    if (!this.client) return;
    let ret = [];
    let addresses = await this.db.GetNavAddresses();

    const addrTotal = addresses.length;
    const SKIP_STAKING_LOOKUP = true;
    for (let i in addresses) {
      const idx = parseInt(i) + 1;
      if (!stakingAddress) {
        if (!this.requestedStakingKeys && !SKIP_STAKING_LOOKUP) {
          let stakingAddresses = await this.client.blockchain_staking_getKeys(
            new Buffer(addresses[i].hash, 'hex').reverse().toString('hex'),
          );

          for (let j in stakingAddresses) {
            await this.AddStakingAddress(
              stakingAddresses[j][0],
              stakingAddresses[j][1],
              false,
            );
          }
        }

        ret.push(this.AddressToScriptHash(addresses[i].address));
      } else {
        ret.push(
          this.ScriptToScriptHash(
            new _bitcoreLib.default.Script.fromAddresses(
              stakingAddress,
              _bitcoreLib.default.Address(addresses[i].address),
            ),
          ),
        );
      }
    }

    this.requestedStakingKeys = true;
    if (!stakingAddress)
      ret.push(
        Buffer.from(
          _bitcoreLib.default.crypto.Hash.sha256(
            _bitcoreLib.default.Script.fromHex('51').toBuffer(),
          ).reverse(),
        ).toString('hex'),
      );
    return ret;
  }

  async GetStakingAddresses() {
    let ret = [];
    let addresses = await this.db.GetStakingAddresses();

    for (let i in addresses) {
      ret.push(addresses[i].address);
    }

    return ret;
  }

  async GetStatusHashForScriptHash(s) {
    return await this.db.GetStatusForScriptHash(s);
  }

  async SetMasterKey(masterkey, key) {
    if (await this.db.GetMasterKey(key)) return false;
    let masterKey = (
      this.type === 'navcoin-core'
        ? _bitcoreLib.default.HDPrivateKey.fromSeed(masterkey)
        : masterkey
    ).toString();

    let masterPubKey = _bitcoreLib.default
      .HDPrivateKey(masterKey)
      .hdPublicKey.toString();

    let { masterViewKey, masterSpendKey } = blsct.DeriveMasterKeys(
      this.type === 'navcoin-core'
        ? _bitcoreLib.default.PrivateKey(masterkey)
        : _bitcoreLib.default.HDPrivateKey(masterKey),
    );
    let masterSpendPubKey = blsct.mcl.mul(blsct.G(), masterSpendKey);
    let masterViewPubKey = blsct.mcl.mul(blsct.G(), masterViewKey);
    await this.db.AddMasterKey('nav', masterKey, key);
    await this.db.AddMasterKey(
      'xNavSpend',
      masterSpendKey.serializeToHexStr(),
      key,
    );
    await this.db.SetValue('masterViewKey', masterViewKey.serializeToHexStr());
    await this.db.SetValue(
      'masterSpendPubKey',
      masterSpendPubKey.serializeToHexStr(),
    );
    await this.db.SetValue(
      'masterViewPubKey',
      masterViewPubKey.serializeToHexStr(),
    );
    await this.db.SetValue('masterPubKey', masterPubKey);
    this.Log('master keys written');
    return true;
  }

  ClearNodeList() {
    this.electrumNodes = [];
  }

  AddNode(host, port, proto) {
    this.electrumNodes.push({
      host,
      port,
      proto,
    });
  }

  async Connect() {
    let resetFailed =
      arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : true;
    if (this.client && this.client.status == 1) return false;
    this.Disconnect();
    if (!this.electrumNodes[this.electrumNodeIndex]) this.electrumNodeIndex = 0;
    if (!this.electrumNodes[this.electrumNodeIndex])
      throw new Error('No nodes in the list, use AddNode');
    this.emit('connecting');
    this.client = new _electrumClientJs.default(
      this.electrumNodes[this.electrumNodeIndex].host,
      this.electrumNodes[this.electrumNodeIndex].port,
      this.electrumNodes[this.electrumNodeIndex].proto,
    );
    this.Log(
      'Trying to connect to '
        .concat(this.electrumNodes[this.electrumNodeIndex].host, ':')
        .concat(this.electrumNodes[this.electrumNodeIndex].port),
    );
    this.client.subscribe.on('socket.error', async (e) => {
      this.connected = false;
      this.emit('disconnected');
      this.emit('connection_failed');
      console.error(
        'error connecting to electrum '
          .concat(this.electrumNodes[this.electrumNodeIndex].host, ':')
          .concat(this.electrumNodes[this.electrumNodeIndex].port, ': ')
          .concat(e),
      );
      await this.ManageElectrumError(e);
    });
    this.client.subscribe.on('ready', async () => {
      const client = this.client;
      if (!client) return;
      this.emit(
        'connected',
        this.electrumNodes[this.electrumNodeIndex].host +
          ':' +
          this.electrumNodes[this.electrumNodeIndex].port,
      );
      this.connected = true;
      if (resetFailed) this.failedConnections = 0;
      this.emit('bootstrap_started');
      let tip = (await client.blockchain_headers_subscribe()).height;
      client.blockchain_consensus_subscribe().then((consensus) => {
        this.db.WriteConsensusParameters(consensus);
      });
      await client.blockchain_dao_subscribe();
      if (this.client !== client) return;
      await this.SetTip(tip);

      if (this.newWallet && !this.creationTip && this.type != 'watch') {
        this.creationTip = tip;
        await this.db.SetValue('creationTip', tip);
      }

      client.subscribe.on('blockchain.headers.subscribe', async (event) => {
        await this.SetTip(event[0].height);
      });
      client.subscribe.on('blockchain.outpoint.subscribe', async (event) => {
        if (event[1] && event[1].spender_txhash)
          await this.db.RemoveTxCandidate(
            event[0][0] + ':' + event[0][1],
            this.network,
          );
      });
      client.subscribe.on('blockchain.consensus.subscribe', async (event) => {
        await this.db.WriteConsensusParameters(event);
      });
      let candidates = await this.db.GetCandidates(this.network);

      for (let i in candidates) {
        let currentStatus = await client.blockchain_outpoint_subscribe(
          candidates[i].input.split(':')[0],
          candidates[i].input.split(':')[1],
        );
        if (currentStatus && currentStatus.spender_txhash)
          await this.db.RemoveTxCandidate(candidates[i].input, this.network);
      }

      if (this.useP2p) {
        this.p2pPool = new p2p({
          dnsSeed: false,
          // prevent seeding with DNS discovered known peers upon connecting
          listenAddr: false,
          // prevent new peers being added from addr messages
          network: this.network,
          maxSize: 1,
          addrs: [
            // initial peers to connect to
            {
              ip: {
                v4: this.electrumNodes[this.electrumNodeIndex].host,
              },
            },
          ],
        });
      }

      if (this.p2pPool && (await this.GetCandidates()).length < 100) {
        console.log('connecting to p2p');
        this.p2pPool.on('candidate', this.NewCandidate);
        this.p2pPool.on('peerready', (_, server) => {
          if (this.p2pPool) {
            let sessionId = this.p2pPool.startSession();
            console.log('started session', sessionId);
          }
        });
        this.p2pPool.connect();
      }

      client.subscribe.on('blockchain.dao.subscribe', async (event) => {
        let type =
          event[0].t == 'c' ? this.daoConsultations : this.daoProposals;
        let hash = event[0].w.hash;
        let remove = event[0].r;

        if (event[0].t == 'c') {
          this.emit(
            remove ? 'dao_consultation_remove' : 'dao_consultation',
            event[0].w,
          );
        } else if (event[0].t == 'p') {
          this.emit(
            remove ? 'dao_proposal_remove' : 'dao_proposal',
            event[0].w,
          );
        }

        if (remove) {
          delete type[hash];
        } else {
          type[hash] = event[0].w;
        }
      });
      if (!this.client || this.client !== client) return;
      await this.Sync();
      if (!this.client || this.client !== client) return;
      client.subscribe.on('blockchain.scripthash.subscribe', async (event) => {
        await this.ReceivedScriptHashStatus(event[0], event[1]);
      });
    });
    await this.client.connect('navcoin-js', '1.5');
    if (this.client.status == 0) return false;
  }

  async GetCandidates() {
    return await this.db.GetCandidates(this.network);
  }

  async GetConsensusParameters() {
    return await this.db.GetConsensusParameters();
  }

  GetConsultations() {
    return this.daoConsultations;
  }

  GetProposals() {
    return this.daoProposals;
  }

  async QueueTx(hash, inMine, height, requestInputs, priority) {
    this.queue.add(
      this,
      this.GetTx,
      [hash, inMine, height, requestInputs],
      priority,
    );
  }

  async QueueTxKeys(hash, height, useCache, priority) {
    this.queue.add(this, this.GetTxKeys, [hash, height, useCache], priority);
  }

  async Sync() {
    let staking =
      arguments.length > 0 && arguments[0] !== undefined
        ? arguments[0]
        : undefined;

    if (!this.client || this.client.status === 0) {
      await this.Connect();
    }

    let txs = new _list.default();
    this.emit('bootstrap_started');
    txs.on('push', () => {
      this.emit('bootstrap_progress', txs.list.length);
    });
    await this.SyncTxHashes(staking, txs);

    for (let tx of txs.list) {
      await this.QueueTxKeys(tx[0], tx[1], tx[2]);
    }

    this.emit('bootstrap_finished');

    if (txs.list.length == 0) {
      this.spendingPassword = '';
      this.emit('sync_finished');
    }
  }

  async SyncUtxos() {
    if (!this.client || this.client.status === 0) {
      await this.Connect();
    }

    this.emit('bootstrap_started');

    const BATCH_SIZE = 10;
    const GAP_LIMIT = 100;
    let totalUtxos = [];
    let lastUsedIndex = -1;
    let checkedCount = 0;
    let done = false;

    while (!done) {
      // Expand pool if we're near the edge.
      let addresses = await this.db.GetNavReceivingAddresses(true);
      const currentPoolSize = addresses.filter((a) => !a.change).length;

      if (checkedCount >= currentPoolSize) {
        const needed = checkedCount + BATCH_SIZE;
        await this.NavFillKeyPool(this.spendingPassword, needed);
        addresses = await this.db.GetNavReceivingAddresses(true);
      }

      const scriptHashes = await this.GetScriptHashes();
      const batch = scriptHashes.slice(checkedCount, checkedCount + BATCH_SIZE);

      if (batch.length === 0) {
        await this.NavFillKeyPool(this.spendingPassword, checkedCount + BATCH_SIZE);
        continue;
      }

      // Phase 1: check balances.
      const balanceResults = await Promise.all(
        batch.map(async (s) => {
          try {
            const bal = await this.client.blockchain_scripthash_get_balance(s);
            return { s, funded: (bal.confirmed || 0) + (bal.unconfirmed || 0) > 0 };
          } catch {
            return { s, funded: false };
          }
        }),
      );

      const fundedInBatch = balanceResults.filter((r) => r.funded);

      // Phase 2: fetch UTXOs for funded addresses only.
      if (fundedInBatch.length > 0) {
        const utxoResults = await Promise.all(
          fundedInBatch.map(async (r) => {
            try {
              const utxos = await this.client.blockchain_scripthash_listunspent(r.s);
              return utxos.map((u) => ({ ...u, scriptHash: r.s }));
            } catch {
              return [];
            }
          }),
        );
        for (const utxos of utxoResults) {
          totalUtxos.push(...utxos);
        }
        lastUsedIndex = checkedCount + batch.length;
      }

      checkedCount += batch.length;
      this.emit('scripthash_progress', checkedCount, checkedCount + GAP_LIMIT);

      // Stop when we've checked GAP_LIMIT addresses past the last used one.
      if (checkedCount - lastUsedIndex >= GAP_LIMIT) {
        done = true;
      }
    }

    for (const utxo of totalUtxos) {
      await this.db.AddTxCandidate(
        utxo.tx_hash,
        utxo.height,
        utxo.value,
        utxo.scriptHash,
      );
    }

    this.emit('bootstrap_finished');
    this.spendingPassword = '';
    this.emit('sync_finished');
  }

  async SyncTxHashes() {
    let staking =
      arguments.length > 0 && arguments[0] !== undefined
        ? arguments[0]
        : undefined;
    let txs = arguments.length > 1 ? arguments[1] : undefined;
    let scriptHashes = await this.GetScriptHashes(staking);

    if (!this.alreadyQueued && !staking) {
      let pending = await this.db.GetPendingTxs();

      for (let j in pending) {
        txs.push([pending[j].tx_hash, pending[j].height, true], false);
      }

      this.emit('bootstrap_progress', txs.list.length);
      this.Log('Queuing '.concat(pending.length, ' pending transactions'));
      this.alreadyQueued = true;

      for (let i in scriptHashes) {
        let s = scriptHashes[i];
        this.firstSynced[s] = false;
      }
    }

    const total = scriptHashes.length;
    const BATCH_SIZE = 10;
    for (let batchStart = 0; batchStart < total; batchStart += BATCH_SIZE) {
      const batch = scriptHashes.slice(batchStart, batchStart + BATCH_SIZE);
      const index = batchStart + 1;
      this.emit('scripthash_progress', index, total);

      const promises = batch.map(async (s) => {
        try {
          this.firstSynced[s] = false;
          if (!this.client) return;
          let currentStatus =
            await this.client.blockchain_scripthash_subscribe(s);
          await this.ReceivedScriptHashStatus(s, currentStatus, txs);
        } catch (e) {
          // Silent fail - don't spam logs
        }
      });
      await Promise.all(promises);
    }

    if (!staking) {
      let stakingAddresses = await this.GetStakingAddresses();

      for (let k in stakingAddresses) {
        let address = stakingAddresses[k];
        await this.SyncTxHashes(address, txs);
      }
    }
  }

  async ManageElectrumError(e) {
    if (
      e == 'Error: close connect' ||
      e == 'Error: connection not established' ||
      e
        .toString()
        .substr(0, 'Error: failed to connect to electrum server:'.length) ==
        'Error: failed to connect to electrum server:' ||
      e == 'server busy - request timed out'
    ) {
      this.connected = false;
      this.electrumNodeIndex =
        (this.electrumNodeIndex + 1) % this.electrumNodes.length;
      this.emit('connection_failed');
      if (this.client) this.client.close();
      this.failedConnections = this.failedConnections + 1;
      this.Log('Reconnecting to electrum node '.concat(this.electrumNodeIndex));

      if (this.failedConnections >= this.electrumNodes.length) {
        this.emit('no_servers_available');
        await sleep(5);
        await this.Connect(true);
      } else {
        await sleep(1);
        await this.Connect(false);
      }
    }

    if (e === 'server busy - request timed out') {
      await sleep(5);
    }
  }

  Disconnect() {
    if (this.client) this.client.close();
    this.connected = false;
    this.queue.stop();
    if (this.p2pPool) this.p2pPool.disconnect();
    this.p2pPool = undefined;
    delete this.client;
    this.emit('disconnected');
  }

  async ReceivedScriptHashStatus(s, status, txs) {
    let prevStatus = await this.GetStatusHashForScriptHash(s);

    if (status && status !== prevStatus) {
      await this.db.SetStatusForScriptHash(s, status);
      this.Log(
        'Received new status '.concat(status, ' for ').concat(s, '. Syncing.'),
      );

      if (!txs) {
        this.queue.add(
          this,
          this.SyncScriptHash,
          [s],
          true,
          !this.firstSyncCompleted,
        );
      } else {
        await this.SyncScriptHash(s, txs);
      }
    } else {
      this.firstSynced[s] = true;

      if (!this.firstSyncCompleted) {
        this.firstSyncCompleted = true;

        for (let i in this.firstSynced) {
          this.firstSyncCompleted &= this.firstSynced[i];
        }
      }
    }
  }

  async SyncScriptHash(scripthash, txs) {
    let reset =
      arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : false;
    let currentHistory = [];
    let prevMaxHeight = -10;
    let lb = this.lastBlock + 0;
    this.Log('Syncing ' + scripthash);
    let historyRange = {};

    while (true) {
      try {
        currentHistory = await this.db.GetScriptHashHistory(scripthash);
      } catch (e) {
        this.Log('error getting history from db: '.concat(e));
      }

      let currentLastHeight = this.creationTip ? this.creationTip : 0;

      if (!reset) {
        for (let i in currentHistory) {
          if (currentHistory[i].height > currentLastHeight)
            currentLastHeight = currentHistory[i].height;
        }
      }

      let filteredHistory = currentHistory.filter(
        (e) => e.height >= 0 && e.height < Math.max(1, currentLastHeight - 10),
      );
      historyRange = currentHistory
        .filter((x) => !filteredHistory.includes(x))
        .reduce(function (map, obj) {
          map[obj.tx_hash] = obj;
          return map;
        }, {});
      currentHistory = filteredHistory;
      await this.db.CleanScriptHashHistory(
        scripthash,
        0,
        Math.max(1, currentLastHeight - 10),
      );
      let newHistory = [];

      try {
        this.Log(
          'requesting tx history for '
            .concat(scripthash, ' from ')
            .concat(currentLastHeight - 10),
        );
        if (!this.client) return;
        newHistory = await this.client.blockchain_scripthash_getHistory(
          scripthash,
          Math.max(0, currentLastHeight - 10),
        );
        this.Log(
          ''
            .concat(scripthash, ': received ')
            .concat(newHistory.history.length, ' transactions'),
        );
      } catch (e) {
        this.Log('error getting history: '.concat(e));
        await this.ManageElectrumError(e);
        return false;
      }

      if (!newHistory.history.length || newHistory.history.length == 0) break;
      let maxHeight;

      for (let i in newHistory.history) {
        if (newHistory.history[i].height > maxHeight)
          maxHeight = newHistory.history[i].height;
      }

      if (maxHeight == prevMaxHeight) break;
      prevMaxHeight = maxHeight;
      currentLastHeight = 0;
      let reachedMempool = newHistory.to_height == -1;
      let toAddBulk = [];

      for (let j in newHistory.history) {
        if (newHistory.history[j].height > currentLastHeight)
          currentLastHeight = newHistory.history[j].height;
        if (newHistory.history[j].height <= 0) reachedMempool = true;
        currentHistory.push(newHistory.history[j]);
        toAddBulk.push({
          id: scripthash + '_' + newHistory.history[j].tx_hash,
          scriptHash: scripthash,
          tx_hash: newHistory.history[j].tx_hash,
          height: newHistory.history[j].height,
          fetched: 0,
        });
        let hash = newHistory.history[j].tx_hash;
        let height = newHistory.history[j].height;
      }

      await this.db.BulkRawInsertHistory(toAddBulk);

      for (var i in toAddBulk) {
        if (txs) {
          txs.push([toAddBulk[i].tx_hash, toAddBulk[i].height, true], false);
          if (i % 100 == 0) this.emit('bootstrap_progress', txs.list.length);
        } else {
          await this.QueueTxKeys(
            toAddBulk[i].tx_hash,
            toAddBulk[i].height,
            true,
          );
          if (i % 100 == 0) this.queue.emitProgress();
        }
      }

      if (txs) {
        this.emit('bootstrap_progress', txs.list.length);
      }

      toAddBulk = [];
      this.queue.emitProgress();
      if (reachedMempool || (currentLastHeight >= lb && lb > 0)) break;
    }

    this.Log(
      'Finished receiving transaction list for script '.concat(scripthash),
    );
    /*for (let e in historyRange)
      {
          await this.db.asyncRemove({wallettxid: historyRange[e].tx_hash}, { multi: true })
          await this.db.asyncRemove({outPoint: {$regex: new RegExp(`^${historyRange[e].tx_hash}:`)}}, { multi: true })
           let tx = await this.GetTx(historyRange[e].tx_hash)
           for (let i in tx.tx.inputs)
          {
              let input = tx.tx.inputs[i].toObject();
               await this.Spend(`${input.prevTxId}:${input.outputIndex}`, '')
               await this.db.asyncRemove({outPoint: `${input.prevTxId}:${input.outputIndex}`}, { multi: true })
          }
           this.emit('remove_tx', historyRange[e].tx_hash);
      }*/

    if (!this.firstSynced) return;
    this.firstSynced[scripthash] = true;

    if (!this.firstSyncCompleted) {
      this.firstSyncCompleted = true;

      for (let i in this.firstSynced) {
        this.firstSyncCompleted &= this.firstSynced[i];
      }

      if (this.firstSyncCompleted) {
        //this.emit("sync_started");
      }
    } else {
      //this.emit("sync_started");
    }
  }

  Sign(key, msg) {
    if (_lodash.default.isString(key)) {
      return this.Sign(_bitcoreLib.default.PrivateKey.fromWIF(key), msg);
    }

    return (0, _bitcoreMessage.default)(msg).sign(key);
  }

  VerifySignature(address, msg, sig) {
    return (0, _bitcoreMessage.default)(msg).verify(address, sig);
  }

  async GetHistory() {
    return await this.db.GetWalletHistory();
  }

  async GetUtxos() {
    let type =
      arguments.length > 0 && arguments[0] !== undefined
        ? arguments[0]
        : _output_types.default.NAV | _output_types.default.STAKED;
    let address =
      arguments.length > 1 && arguments[1] !== undefined
        ? arguments[1]
        : undefined;
    let tokenId =
      arguments.length > 2 && arguments[2] !== undefined
        ? arguments[2]
        : new Buffer(new Uint8Array(32));
    let tokenNftId =
      arguments.length > 3 && arguments[3] !== undefined ? arguments[3] : -1;
    if (address instanceof _bitcoreLib.default.Address)
      return await this.GetUtxos(type, address.hashBuffer, tokenId, tokenNftId);
    if (
      typeof address === 'string' &&
      !_bitcoreLib.default.util.js.isHexa(address)
    )
      return await this.GetUtxos(
        type,
        _bitcoreLib.default.Address(address),
        tokenId,
        tokenNftId,
      );
    if (typeof address === 'object') address = address.toString('hex');
    let utxos = await this.db.GetUtxos();
    let tip = await this.GetTip();
    let ret = [];

    for (let u in utxos) {
      let utxo = utxos[u];
      if (!(utxo.type & type)) continue;
      let outpoint = utxo.id.split(':');
      let tx = await this.db.GetTx(outpoint[0]);
      let pending = false;
      if (
        (tx.pos < 2 && tip - tx.height < 120) ||
        (tx.height <= 0 && type == _output_types.default.XNAV)
      )
        pending = true;

      if (!pending) {
        let out = _bitcoreLib.default.Transaction.Output.fromBufferReader(
          new _bitcoreLib.default.encoding.BufferReader(
            new Buffer(utxo.out, 'hex'),
          ),
        );

        out.tokenId = out.tokenId;
        if (
          out.tokenId &&
          out.tokenNftId &&
          !(
            out.tokenId.toString('hex') == tokenId.toString('hex') &&
            out.tokenNftId == tokenNftId
          )
        )
          continue;

        if (address) {
          if (
            utxo.type & _output_types.default.STAKED &&
            utxo.stakingPk != address
          ) {
            continue;
          } else if (
            utxo.type & _output_types.default.NAV &&
            utxo.spendingPk != address
          ) {
            continue;
          }

          if (
            utxo.type & _output_types.default.VOTING &&
            utxo.votingPk != address
          ) {
            continue;
          }
        }

        let item = {
          txid: outpoint[0],
          vout: outpoint[1],
          output: out,
          amount: utxo.amount,
          type: utxo.type,
          tokenId: out.tokenId.toString('hex'),
          tokenNftId: out.tokenNftId == -1 ? undefined : out.tokenNftId,
          stakingPk: utxo.stakingPk,
          votingPk: utxo.votingPk,
          spendingPk: utxo.spendingPk,
        };

        if (out.isCt() || out.isNft()) {
          let hashid = new Buffer(blsct.GetHashId(out, this.mvk)).toString(
            'hex',
          );
          item.accIndex = await this.db.GetKey(hashid);
        }

        ret.push(item);
      }
    }

    return ret;
  }

  async GetBalance(address) {
    if (address instanceof _bitcoreLib.default.Address)
      return await this.GetBalance(address.hashBuffer);
    if (
      typeof address === 'string' &&
      !_bitcoreLib.default.util.js.isHexa(address)
    )
      return await this.GetBalance(_bitcoreLib.default.Address(address));
    if (typeof address === 'object') address = address.toString('hex');
    let utxos = await this.db.GetUtxos(true);
    let navConfirmed = _bitcoreLib.default.crypto.BN.Zero;
    let xNavConfirmed = _bitcoreLib.default.crypto.BN.Zero;
    let tokConfirmed = {};
    let coldConfirmed = _bitcoreLib.default.crypto.BN.Zero;
    let votingConfirmed = _bitcoreLib.default.crypto.BN.Zero;
    let navPending = _bitcoreLib.default.crypto.BN.Zero;
    let xNavPending = _bitcoreLib.default.crypto.BN.Zero;
    let tokPending = {};
    let coldPending = _bitcoreLib.default.crypto.BN.Zero;
    let votingPending = _bitcoreLib.default.crypto.BN.Zero;
    let tip = await this.GetTip();

    for (let u in utxos) {
      let utxo = utxos[u];
      let prevHash = utxo.id.split(':')[0];
      let prevOut = utxo.id.split(':')[1];
      let tx = await this.db.GetTx(prevHash);
      if (!tx) continue;
      let pending = false;
      if (
        (tx.pos < 2 && tip - tx.height < 120) ||
        tx.height <= 0 ||
        (tx.height == undefined && tx.pos == undefined)
      )
        pending = true;

      if (
        utxo.type & _output_types.default.XNAV &&
        (!address || utxo.hashId == address) &&
        utxo.amount > 0
      ) {
        let txObj = _bitcoreLib.default.Transaction(tx.hex);

        let tokId = {
          tokenId: txObj.outputs[prevOut].tokenId.toString('hex'),
          tokenNftId: txObj.outputs[prevOut].tokenNftId.toString(),
        };

        if (
          tokId.tokenId ==
            '0000000000000000000000000000000000000000000000000000000000000000' &&
          tokId.tokenNftId == -1
        ) {
          if (pending)
            xNavPending = xNavPending.add(
              new _bitcoreLib.default.crypto.BN(utxo.amount),
            );
          else
            xNavConfirmed = xNavConfirmed.add(
              new _bitcoreLib.default.crypto.BN(utxo.amount),
            );
        } else {
          if (pending) {
            if (!tokPending[tokId.tokenId + ':' + tokId.tokenNftId])
              tokPending[tokId.tokenId + ':' + tokId.tokenNftId] = 0;
            tokPending[tokId.tokenId + ':' + tokId.tokenNftId] =
              tokPending[tokId.tokenId + ':' + tokId.tokenNftId] + utxo.amount;
          } else {
            if (!tokConfirmed[tokId.tokenId + ':' + tokId.tokenNftId])
              tokConfirmed[tokId.tokenId + ':' + tokId.tokenNftId] = 0;
            tokConfirmed[tokId.tokenId + ':' + tokId.tokenNftId] =
              tokConfirmed[tokId.tokenId + ':' + tokId.tokenNftId] +
              utxo.amount;
          }
        }
      } else {
        if (
          utxo.type & _output_types.default.STAKED &&
          (!address || utxo.stakingPk == address)
        ) {
          if (pending)
            coldPending = coldPending.add(
              new _bitcoreLib.default.crypto.BN(utxo.amount),
            );
          else
            coldConfirmed = coldConfirmed.add(
              new _bitcoreLib.default.crypto.BN(utxo.amount),
            );
        } else if (
          utxo.type & _output_types.default.NAV &&
          (!address || utxo.spendingPk == address)
        ) {
          if (pending)
            navPending = navPending.add(
              new _bitcoreLib.default.crypto.BN(utxo.amount),
            );
          else
            navConfirmed = navConfirmed.add(
              new _bitcoreLib.default.crypto.BN(utxo.amount),
            );
        }

        if (
          utxo.type & _output_types.default.VOTING &&
          (!address || utxo.votingPk == address)
        ) {
          if (pending)
            votingPending = votingPending.add(
              new _bitcoreLib.default.crypto.BN(utxo.amount),
            );
          else
            votingConfirmed = votingConfirmed.add(
              new _bitcoreLib.default.crypto.BN(utxo.amount),
            );
        }
      }
    }

    let ret = {
      nav: {
        confirmed: navConfirmed.toNumber(),
        pending: navPending.toNumber(),
      },
      xnav: {
        confirmed: xNavConfirmed.toNumber(),
        pending: xNavPending.toNumber(),
      },
      tokens: {},
      nfts: {},
      staked: {
        confirmed: coldConfirmed.toNumber(),
        pending: coldPending.toNumber(),
      },
      voting: {
        confirmed: votingConfirmed.toNumber(),
        pending: votingPending.toNumber(),
      },
    };

    for (let i in tokConfirmed) {
      let tokenId = i.split(':')[0];
      let tokenNftId = i.split(':')[1];

      if (tokenNftId == -1) {
        if (!ret.tokens[tokenId]) {
          ret.tokens[tokenId] = {};
          let info = await this.GetTokenInfo(tokenId);
          ret.tokens[tokenId].name = info.name;
          ret.tokens[tokenId].code = info.code;
          ret.tokens[tokenId].supply = info.supply;
        }

        ret.tokens[tokenId].confirmed = tokConfirmed[i];
      } else {
        if (!ret.nfts[tokenId]) {
          ret.nfts[tokenId] = {};
          let info = await this.GetTokenInfo(tokenId);
          ret.nfts[tokenId].name = info.name;
          ret.nfts[tokenId].scheme = info.code;
          ret.nfts[tokenId].supply = info.supply;
          ret.nfts[tokenId].confirmed = {};
          ret.nfts[tokenId].pending = {};
        }

        let nftInfo = await this.GetNftInfo(tokenId, tokenNftId);
        ret.nfts[tokenId].confirmed[tokenNftId] = nftInfo
          ? nftInfo[0].metadata
          : '';
      }
    }

    for (let i in tokPending) {
      let tokenId = i.split(':')[0];
      let tokenNftId = i.split(':')[1];

      if (tokenNftId == -1) {
        if (!ret.tokens[tokenId]) {
          ret.tokens[tokenId] = {};
          let info = await this.GetTokenInfo(tokenId);
          ret.tokens[tokenId].name = info.name;
          ret.tokens[tokenId].code = info.code;
          ret.tokens[tokenId].supply = info.supply;
        }

        ret.tokens[tokenId].pending = tokPending[i];
      } else {
        if (!ret.nfts[tokenId]) {
          ret.nfts[tokenId] = {};
          let info = await this.GetTokenInfo(tokenId);
          ret.nfts[tokenId].name = info.name;
          ret.nfts[tokenId].scheme = info.code;
          ret.nfts[tokenId].supply = info.supply;
          ret.nfts[tokenId].pending = {};
          ret.nfts[tokenId].confirmed = {};
        }

        let nftInfo = await this.GetNftInfo(tokenId, tokenNftId);
        if (nftInfo)
          ret.nfts[tokenId].pending[tokenNftId] = nftInfo[0]
            ? nftInfo[0].metadata
            : '';
      }
    }

    return ret;
  }

  async GetTokenInfo(id) {
    let ret = await this.db.GetTokenInfo(id);
    if (!this.client) return {};

    if (!ret || !ret.name) {
      try {
        let token = await this.client.blockchain_token_getToken(id);
        if (!token || (token && !token.name)) return {};
        await this.db.AddTokenInfo(
          token.id,
          token.name,
          token.token_code ? token.token_code : token.scheme,
          token.max_supply,
          token.version,
          token.pubkey,
        );
        return {
          id: token.id,
          name: token.name,
          code: token.token_code ? token.token_code : token.scheme,
          supply: token.max_supply,
          version: token.version,
          key: token.pubkey,
        };
      } catch (e) {
        console.log(e);
        return {};
      }
    } else {
      return ret;
    }
  }

  async GetNftInfo(id, nftId) {
    let ret = await this.db.GetNftInfo(id, nftId);
    if (!this.client) return;

    if (!ret || !ret.metadata) {
      try {
        let token = await this.client.blockchain_token_getNft(
          id,
          parseInt(nftId),
        );
        if (!token || (token && !token.nfts)) return undefined;
        let retArray = [];

        for (let n in token.nfts) {
          if (nftId != -1 && token.nfts[n].index != nftId) continue;
          await this.db.AddNftInfo(
            token.id,
            token.nfts[n].index,
            token.nfts[n].metadata,
          );
          retArray.push({
            id: token.nfts[n].index,
            metadata: token.nfts[n].metadata,
          });
        }

        return retArray;
      } catch (e) {
        console.log(e);
        return undefined;
      }
    } else {
      return [{ ...ret, id: parseInt(ret.id.split('-')[1]) }];
    }
  }

  async AddOutput(outpoint, out, height) {
    let amount = out.amount ? out.amount : out.satoshis;
    let label = out.isCt()
      ? out.memo
      : out.script.toAddress(this.network).toString();
    let isCold =
      out.script.isColdStakingOutP2PKH() || out.script.isColdStakingV2Out();
    let type = 0x0;
    if (out.isCt() || out.isNft()) type |= _output_types.default.XNAV;
    else {
      if (isCold) type |= _output_types.default.STAKED;
      else type |= _output_types.default.NAV;
    }

    try {
      let stakingPk;
      let spendingPk;
      let votingPk;
      let hashId;

      if (out.script.isColdStakingOutP2PKH()) {
        spendingPk = out.script.getPublicKeyHash().toString('hex');
        stakingPk = out.script.getStakingPublicKeyHash().toString('hex');
      } else if (out.script.isColdStakingV2Out()) {
        spendingPk = out.script.getPublicKeyHash().toString('hex');
        stakingPk = out.script.getStakingPublicKeyHash().toString('hex');
        votingPk = out.script.getVotingPublicKeyHash().toString('hex');
      } else if (out.script.isPublicKeyOut()) {
        spendingPk = ripemd160(sha256(out.script.getPublicKey())).toString(
          'hex',
        );
      } else if (out.script.isPublicKeyHashOut()) {
        spendingPk = out.script.getPublicKeyHash().toString('hex');
      }

      if (out.isCt() || out.isNft()) {
        hashId = new Buffer(blsct.GetHashId(out, this.mvk)).toString('hex');
      }

      await this.db.AddUtxo(
        outpoint,
        out.toBufferWriter().toBuffer().toString('hex'),
        '',
        amount,
        label,
        type,
        spendingPk,
        stakingPk,
        votingPk,
        hashId,
      );

      if (!(out.isCt() || out.isNft())) {
        await this.db.UseNavAddress(
          out.script.toAddress(this.network).toString(),
        );

        if (
          (await this.GetPoolSize(_address_types.default.NAV)) <
          this.GetMinPoolSize()
        ) {
          this.Log('Filling NAV key pool');
          await this.NavFillKeyPool(
            this.spendingPassword,
            this.GetMinPoolSize() * 2,
          );
        }
      } else {
        await this.db.UseXNavAddress(hashId);
      }

      return true;
    } catch (e) {
      return false;
    }
  }

  async Spend(outPoint, spentIn) {
    let prev = await this.db.GetUtxo(outPoint);

    if (prev && prev.spentIn && spentIn && prev.spentIn == spentIn) {
      return false;
    }

    await this.db.SpendUtxo(outPoint, spentIn);
    return true;
  }

  async LockOrderInputs(order) {
    const tx = _bitcoreLib.default.Transaction(order.tx[0]);

    for (let input of tx.inputs) {
      let outPoint = input.prevTxId.toString('hex') + ':' + input.outputIndex;
      await this.db.SpendUtxo(outPoint, 'locked-order');
    }

    this.emit('new_tx', []);
  }

  async UnlockOrderInputs(order) {
    const tx = _bitcoreLib.default.Transaction(order.tx[0]);

    for (let input of tx.inputs) {
      let outPoint = input.prevTxId.toString('hex') + ':' + input.outputIndex;
      let currentStatus = await this.client.blockchain_outpoint_subscribe(
        input.prevTxId.toString('hex'),
        input.outputIndex,
      );
      await this.client.blockchain_outpoint_unsubscribe(
        input.prevTxId.toString('hex'),
        input.outputIndex,
      );
      if (currentStatus && currentStatus.spender_txhash)
        await this.db.SpendUtxo(outPoint, currentStatus.spender_txhash);
      else await this.db.SpendUtxo(outPoint, '');
    }

    this.emit('new_tx', []);
  }

  async GetTx(hash, inMine, height) {
    let requestInputs =
      arguments.length > 3 && arguments[3] !== undefined ? arguments[3] : true;
    let tx;
    let prevHeight;
    let cacheTx = await this.db.GetTx(hash);

    if (cacheTx) {
      cacheTx.tx = _bitcoreLib.default.Transaction(cacheTx.hex);
      tx = cacheTx;
      prevHeight = tx.height + 0;
    }

    if (!tx) {
      let tx_;

      try {
        if (!this.client) return;
        tx_ = await this.client.blockchain_transaction_get(hash, false);
      } catch (e) {
        this.Log('error getting tx '.concat(hash, ': ').concat(e));
        await this.ManageElectrumError(e);
        await sleep(1);
        return await this.GetTx(hash, inMine, height, requestInputs);
      }

      tx = {
        txid: hash,
        hex: tx_,
      };

      try {
        await this.db.AddTx(tx);
      } catch (e) {
        console.log('AddTx', e);
      }

      tx.tx = _bitcoreLib.default.Transaction(tx.hex);
    }

    if (!tx.height || tx.height <= 0 || (height && height != tx.height)) {
      let heightBlock;

      try {
        if (!this.client) return;
        heightBlock = await this.client.blockchain_transaction_getMerkle(hash);
        tx.height = heightBlock.block_height;
        tx.pos = heightBlock.pos;
      } catch (e) {}
    }

    let mustNotify = false;

    if (tx.height != prevHeight) {
      if (tx.height) await this.db.SetTxHeight(hash, tx.height, tx.pos);
      mustNotify = true;
    }

    if (!requestInputs) return tx;
    await this.ProcessTx(tx, mustNotify);
    await this.db.MarkAsFetched(hash);
    return tx;
  }

  async ProcessTx(tx) {
    let mustNotify =
      arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : true;
    let mine = false;
    let memos = {
      in: [],
      out: [],
    };
    let deltaNav = 0;
    let deltaXNav = {};
    let deltaCold = 0;
    let addressesIn = {
      spending: [],
      staking: [],
    };
    let addressesOut = {
      spending: [],
      staking: [],
    };

    for (let i in tx.tx.inputs) {
      if (typeof inMine !== 'undefined' && !inMine[i]) continue;
      let input = tx.tx.inputs[i].toObject();
      if (
        input.prevTxId ==
        '0000000000000000000000000000000000000000000000000000000000000000'
      )
        continue;
      let prevTx = (
        await this.GetTx(input.prevTxId, undefined, undefined, false)
      ).tx;
      let prevOut = prevTx.outputs[input.outputIndex];

      if (prevOut.isCt() || prevOut.isNft()) {
        let hid = blsct.GetHashId(prevOut, this.mvk);

        if (hid) {
          let hashId = new Buffer(hid).toString('hex');
          let acc = await this.db.HaveKey(hashId);

          if (acc) {
            if (
              blsct.RecoverBLSCTOutput(
                prevOut,
                this.mvk,
                undefined,
                acc[0],
                acc[1],
                prevOut.tokenId,
                prevOut.tokenNftId,
              )
            ) {
              mine = true;
              let newOutput = await this.AddOutput(
                ''.concat(input.prevTxId, ':').concat(input.outputIndex),
                prevOut,
                prevTx.height,
              );
              let newSpend = await this.Spend(
                ''.concat(input.prevTxId, ':').concat(input.outputIndex),
                ''.concat(tx.txid, ':').concat(i),
              );
              if (newSpend || newOutput) mustNotify = true;
              if (
                !deltaXNav[
                  prevOut.tokenId.toString('hex') + ':' + prevOut.tokenNftId
                ]
              )
                deltaXNav[
                  prevOut.tokenId.toString('hex') + ':' + prevOut.tokenNftId
                ] = 0;
              deltaXNav[
                prevOut.tokenId.toString('hex') + ':' + prevOut.tokenNftId
              ] -= prevOut.amount ? prevOut.amount : prevOut.satoshis;
              memos.in.push(prevOut.memo);
            }
          }
        }
      } else if (
        prevOut.script.isPublicKeyHashOut() ||
        prevOut.script.isPublicKeyOut()
      ) {
        let hashPk = prevOut.script.isPublicKeyOut()
          ? ripemd160(sha256(prevOut.script.getPublicKey()))
          : prevOut.script.getPublicKeyHash();
        let hashId = new Buffer(hashPk).toString('hex');

        let add = _bitcoreLib.default
          .Address(hashPk, this.network, 'pubkeyhash')
          .toString();

        if (addressesIn.spending.indexOf(add) == -1)
          addressesIn.spending.push(add);

        if (await this.db.HaveKey(hashId)) {
          mine = true;
          let newOutput = await this.AddOutput(
            ''.concat(input.prevTxId, ':').concat(input.outputIndex),
            prevOut,
            prevTx.height,
          );
          let newSpend = await this.Spend(
            ''.concat(input.prevTxId, ':').concat(input.outputIndex),
            ''.concat(tx.txid, ':').concat(i),
          );
          if (newSpend || newOutput) mustNotify = true;
          deltaNav -= prevOut.satoshis;
        }
      } else if (
        prevOut.script.isColdStakingOutP2PKH() ||
        prevOut.script.isColdStakingV2Out()
      ) {
        let hashPk = prevOut.script.getPublicKeyHash();
        let hashId = new Buffer(hashPk).toString('hex');

        let addSp = _bitcoreLib.default
          .Address(hashPk, this.network, 'pubkeyhash')
          .toString();

        let addSt = _bitcoreLib.default
          .Address(
            prevOut.script.getStakingPublicKeyHash(),
            this.network,
            'pubkeyhash',
          )
          .toString();

        if (addressesIn.spending.indexOf(addSp) == -1) {
          addressesIn.spending.push(addSp);
        }

        if (addressesIn.staking.indexOf(addSt) == -1) {
          addressesIn.staking.push(addSt);
        }

        if (await this.db.HaveKey(hashId)) {
          mine = true;
          let newOutput = await this.AddOutput(
            ''.concat(input.prevTxId, ':').concat(input.outputIndex),
            prevOut,
            prevTx.height,
          );
          let newSpend = await this.Spend(
            ''.concat(input.prevTxId, ':').concat(input.outputIndex),
            ''.concat(tx.txid, ':').concat(i),
          );
          if (newSpend || newOutput) mustNotify = true;
          deltaCold -= prevOut.satoshis;
        }
      }
    }

    for (let i in tx.tx.outputs) {
      let out = tx.tx.outputs[i];

      if (out.isCt() || out.isNft()) {
        let hid = blsct.GetHashId(out, this.mvk);

        if (hid) {
          let hashId = new Buffer(hid).toString('hex');
          let acc = await this.db.HaveKey(hashId);

          if (acc) {
            if (
              blsct.RecoverBLSCTOutput(
                out,
                this.mvk,
                undefined,
                acc[0],
                acc[1],
                out.tokenId,
                out.tokenNftId,
              )
            ) {
              mine = true;
              let newOutput = await this.AddOutput(
                ''.concat(tx.txid, ':').concat(i),
                out,
                tx.height,
              );
              if (newOutput) mustNotify = true;
              if (
                !deltaXNav[out.tokenId.toString('hex') + ':' + out.tokenNftId]
              )
                deltaXNav[out.tokenId.toString('hex') + ':' + out.tokenNftId] =
                  0;
              deltaXNav[out.tokenId.toString('hex') + ':' + out.tokenNftId] +=
                out.amount ? out.amount : out.satoshis;
              memos.out.push(out.memo);
            }
          }
        }
      } else if (
        out.script.toHex() == '51' &&
        out.tokenNftId.toString() != -1
      ) {
        let hid = blsct.GetHashId(out, this.mvk);

        if (hid) {
          let hashId = new Buffer(hid).toString('hex');

          if (await this.db.HaveKey(hashId)) {
            mine = true;
            let newOutput = await this.AddOutput(
              ''.concat(tx.txid, ':').concat(i),
              out,
              tx.height,
            );
            if (newOutput) mustNotify = true;
            if (!deltaXNav[out.tokenId.toString('hex') + ':' + out.tokenNftId])
              deltaXNav[out.tokenId.toString('hex') + ':' + out.tokenNftId] = 0;
            deltaXNav[out.tokenId.toString('hex') + ':' + out.tokenNftId] +=
              out.amount ? out.amount : out.satoshis;
          }
        }
      } else if (
        out.script.isPublicKeyHashOut() ||
        out.script.isPublicKeyOut()
      ) {
        let hashPk = out.script.isPublicKeyOut()
          ? ripemd160(sha256(out.script.getPublicKey()))
          : out.script.getPublicKeyHash();
        let hashId = new Buffer(hashPk).toString('hex');

        let add = _bitcoreLib.default
          .Address(hashPk, this.network, 'pubkeyhash')
          .toString();

        if (addressesOut.spending.indexOf(add) == -1)
          addressesOut.spending.push(add);

        if (await this.db.HaveKey(hashId)) {
          mine = true;
          let newOutput = await this.AddOutput(
            ''.concat(tx.txid, ':').concat(i),
            out,
            tx.height,
          );
          if (newOutput) mustNotify = true;
          deltaNav += out.satoshis;
        }
      } else if (
        out.script.isColdStakingOutP2PKH() ||
        out.script.isColdStakingV2Out()
      ) {
        let hashPk = out.script.getPublicKeyHash();
        let hashId = new Buffer(hashPk).toString('hex');

        let addSp = _bitcoreLib.default
          .Address(hashPk, this.network, 'pubkeyhash')
          .toString();

        let addSt = _bitcoreLib.default
          .Address(
            out.script.getStakingPublicKeyHash(),
            this.network,
            'pubkeyhash',
          )
          .toString();

        if (addressesOut.spending.indexOf(addSp) == -1)
          addressesOut.spending.push(addSp);
        if (addressesOut.staking.indexOf(addSt) == -1)
          addressesOut.staking.push(addSt);

        if (await this.db.HaveKey(hashId)) {
          mine = true;
          let newOutput = await this.AddOutput(
            ''.concat(tx.txid, ':').concat(i),
            out,
            tx.height,
          );
          if (newOutput) mustNotify = true;
          deltaCold += out.satoshis;
        }
      }

      if (out.vData[0] == 7 || out.vData[0] == 8) {
        try {
          let name = out.vData.slice(5, 5 + out.vData[4]).toString();

          if (await this.IsMyName(name)) {
            let data = await this.ResolveName(name);
            await this.AddName(name, undefined, data);
          }
        } catch (e) {
          console.log(e);
        }
      } else if (out.vData[0] == 2) {
        try {
          let values = _bitcoreLib.default.util.VData.parse(out.vData);

          let id = _bitcoreLib.default.crypto.Hash.sha256sha256(
            Buffer.concat([new Buffer([48]), values[1]]),
          )
            .reverse()
            .toString('hex');

          this.emit('new_token', id);
          await this.db.AddTokenInfo(
            id,
            values[2].toString(),
            values[4].toString(),
            values[5] / (values[3] == 0 ? 1e8 : 1),
            values[3],
            values[1],
          );
          let derived = await this.DeriveSpendingKeyFromStringHash(
            'token/',
            values[2].toString() + values[4].toString(),
            this.spendingPassword,
          );
          let key = blsct.SkToPubKey(new Buffer(derived).toString('hex'));
          let keyId = new Buffer(
            _bitcoreLib.default.crypto.Hash.sha256sha256(
              Buffer.concat([new Buffer([48]), new Buffer(key.serialize())]),
            ),
          )
            .reverse()
            .toString('hex');

          if (keyId == id) {
            try {
              await this.db.AddKey(
                keyId.toString('hex'),
                key.serialize().toString('hex'),
                _address_types.default.TOKEN,
                values[2],
                false,
                false,
                values[4],
                this.spendingPassword,
              );
            } catch (e) {
              console.log(e.message);
            }
          }
        } catch (e) {
          console.log(e);
        }
      } else if (out.vData[0] == 3) {
        try {
          let values = _bitcoreLib.default.util.VData.parse(out.vData);

          let id = _bitcoreLib.default.crypto.Hash.sha256sha256(
            Buffer.concat([new Buffer([48]), values[1]]),
          )
            .reverse()
            .toString('hex');

          console.log(
            'mint token '
              .concat(id, ' ')
              .concat(values[2], ' ')
              .concat(values[3]),
          );

          if (values[3].length > 0) {
            await this.db.AddNftInfo(id, values[2], values[3]);
          }
        } catch (e) {
          console.log(e);
        }
      } else if (out.vData[0] == 6) {
        try {
          let ephKey = new blsct.mcl.G1();
          ephKey.deserialize(out.vData.slice(36, 84));
          let nonce = blsct.mcl.mul(ephKey, this.mvk);

          let decryptKey = _bitcoreLib.default.crypto.Blsct.HashG1Element(
            nonce,
            1,
          );

          let decrypted = this.Decrypt(
            out.vData.slice(84, out.vData.length),
            decryptKey,
          )
            .toString()
            .split(';');
          let decryptedName = decrypted[0];
          let decryptedKey = decrypted[1];
          let sh = decryptedName + decryptedKey;

          let nameHash = _bitcoreLib.default.crypto.Hash.sha256sha256(
            Buffer.concat([new Buffer([sh.length]), new Buffer(sh, 'utf-8')]),
          );

          let bufferHash = new Buffer(nameHash);

          if (
            out.vData.slice(4, 36).toString('hex') == bufferHash.toString('hex')
          ) {
            this.emit('new_name', decryptedName.toString());
            await this.AddName(decryptedName.toString(), tx.height);
          }
        } catch (e) {}
      }
    }

    if (mustNotify && mine) {
      for (let d in deltaXNav) {
        if (deltaXNav[d] != 0 || memos.out.length) {
          let token = d.split(':')[0];
          let nftid = d.split(':')[1];
          let fisxnav =
            token ==
            '0000000000000000000000000000000000000000000000000000000000000000';
          let fistoken = nftid == '-1';
          let info = !fisxnav
            ? await this.GetTokenInfo(token)
            : {
                name: 'xnav',
                code: 'xnav',
              };
          this.emit('new_tx', {
            txid: tx.txid,
            amount: deltaXNav[d],
            type: fisxnav ? 'xnav' : fistoken ? 'token' : 'nft',
            token_name: fisxnav ? 'xnav' : info.name,
            token_code: fisxnav ? 'xnav' : fistoken ? info.code : info.name,
            confirmed: tx.height > -0,
            height: tx.height,
            pos: tx.pos,
            timestamp: tx.tx.time,
            memos: memos,
            strdzeel: tx.strdzeel,
            token_id: token,
            nft_id: nftid,
          });
          await this.db.AddWalletTx(
            tx.txid,
            fisxnav ? 'xnav' : fistoken ? 'token' : 'nft',
            deltaXNav[d],
            tx.height > 0,
            tx.height,
            tx.pos,
            tx.tx.time,
            memos,
            tx.strdzeel,
            addressesIn,
            addressesOut,
            fisxnav ? 'xnav' : info.name,
            fisxnav ? 'xnav' : fistoken ? info.code : info.name,
            token,
            nftid,
          );
        }
      }

      if (deltaNav != 0) {
        this.emit('new_tx', {
          txid: tx.txid,
          amount: deltaNav,
          type: 'nav',
          confirmed: tx.height > 0,
          height: tx.height,
          pos: tx.pos,
          timestamp: tx.tx.time,
          strdzeel: tx.strdzeel,
        });
        await this.db.AddWalletTx(
          tx.txid,
          'nav',
          deltaNav,
          tx.height > 0,
          tx.height,
          tx.pos,
          tx.tx.time,
          tx.strdzeel,
          addressesIn,
          addressesOut,
        );
      }

      if (deltaCold != 0) {
        this.emit('new_tx', {
          txid: tx.txid,
          amount: deltaCold,
          type: 'cold_staking',
          confirmed: tx.height > 0,
          height: tx.height,
          pos: tx.pos,
          timestamp: tx.tx.time,
          strdzeel: tx.strdzeel,
        });
        await this.db.AddWalletTx(
          tx.txid,
          'cold_staking',
          deltaCold,
          tx.height > 0,
          tx.height,
          tx.pos,
          tx.tx.time,
          tx.strdzeel,
          addressesIn,
          addressesOut,
        );
      }
    }
  }

  async GetMyNames() {
    return await this.db.GetMyNames();
  }

  async GetMyTokens() {
    let allTokens = await this.db.GetMyTokens();
    return await asyncFilter(allTokens, async (token) => {
      return this.db.HaveKey(token.id);
    });
  }

  async AddName(name, height) {
    let data =
      arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : {};

    try {
      let exists = await this.db.GetName(name);
      await this.db.AddName(name, height || exists.height, data);
      if (!exists) this.emit('new_name', name, height);
      else this.emit('update_name', name, exists.height, data);
      return true;
    } catch (e) {
      return false;
    }
  }

  IsValidDotNavName(name) {
    if (!name || !name.length) return false;
    if (name.length >= 64 || name.length < 5) return false;
    if (
      !/^[abcdefghijklmnopqrstuvwxyz01234566789][abcdefghijklmnopqrstuvwxyz01234566789-]*\.nav$/.test(
        name,
      )
    )
      return false;
    return true;
  }

  IsValidDotNavKey(key) {
    if (!key || !key.length) return false;
    if (key.length >= 64 || key.length < 1) return false;
    if (
      !/^[abcdefghijklmnopqrstuvwxyz01234566789][abcdefghijklmnopqrstuvwxyz01234566789-]*$/.test(
        key,
      )
    )
      return false;
    return true;
  }

  async IsMyName(name) {
    return await this.db.GetName(name);
  }

  async AddStakingAddress(pk, pk2) {
    let sync =
      arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : false;
    if (
      pk instanceof _bitcoreLib.default.Address ||
      (typeof pk === 'string' &&
        pk != '' &&
        !_bitcoreLib.default.util.js.isHexa(pk))
    )
      pk = _bitcoreLib.default.Address(pk).toObject().hash;
    if (
      pk2 instanceof _bitcoreLib.default.Address ||
      (typeof pk2 === 'string' &&
        pk2 != '' &&
        !_bitcoreLib.default.util.js.isHexa(pk2))
    )
      pk2 = _bitcoreLib.default.Address(pk2).toObject().hash;
    if (pk instanceof Buffer) pk = pk.toString('hex');
    if (pk2 instanceof Buffer) pk2 = pk2.toString('hex');

    let strAddress = _bitcoreLib.default
      .Address(new Buffer(pk, 'hex'), this.network)
      .toString();

    let strAddress2 = pk2
      ? _bitcoreLib.default
          .Address(new Buffer(pk2, 'hex'), this.network)
          .toString()
      : '';
    let isInDb = await this.db.GetStakingAddress(strAddress, strAddress2);

    if (!isInDb) {
      try {
        await this.db.AddStakingAddress(strAddress, strAddress2, pk, pk2);
        this.emit('new_staking_address', strAddress, strAddress2);
        this.Log(
          'New staking address: '.concat(strAddress, ' ').concat(strAddress2),
        );
        if (sync) await this.Sync(strAddress);
      } catch (e) {
        //console.log(e)
      }
    }
  }

  async IsMine(input) {
    if (input.script) {
      let script = _bitcoreLib.default.Script(input.script);

      if (script.isPublicKeyHashOut() || script.isPublicKeyOut()) {
        let hashId = new Buffer(
          script.isPublicKeyOut()
            ? ripemd160(sha256(script.getPublicKey()))
            : script.getPublicKeyHash(),
        ).toString('hex');

        if (await this.db.HaveKey(hashId)) {
          return true;
        }
      } else if (script.isColdStakingOutP2PKH()) {
        let hashId = new Buffer(script.getPublicKeyHash()).toString('hex');

        if (await this.db.HaveKey(hashId)) {
          if (script.isColdStakingOutP2PKH()) {
            let stakingPk = script.getStakingPublicKeyHash();
            await this.AddStakingAddress(stakingPk, undefined, true);
          } else if (script.isColdStakingV2Out()) {
            let stakingPk = script.getStakingPublicKeyHash();
            let votingPk = script.getVotingPublicKeyHash();
            await this.AddStakingAddress(stakingPk, votingPk, true);
          }

          return true;
        }
      } else if (script.isColdStakingV2Out()) {
        let hashId = new Buffer(script.getPublicKeyHash()).toString('hex');
        let hashIdVoting = new Buffer(script.getVotingPublicKeyHash()).toString(
          'hex',
        );

        if (
          (await this.db.HaveKey(hashId)) ||
          (await this.db.HaveKey(hashIdVoting))
        ) {
          if (script.isColdStakingOutP2PKH()) {
            let stakingPk = script.getStakingPublicKeyHash();
            await this.AddStakingAddress(stakingPk, undefined, true);
          } else if (script.isColdStakingV2Out()) {
            let stakingPk = script.getStakingPublicKeyHash();
            let votingPk = script.getVotingPublicKeyHash();
            await this.AddStakingAddress(stakingPk, votingPk, true);
          }

          return true;
        }
      }
    } else if (input.spendingKey && input.outputKey) {
      let hid = blsct.GetHashId(
        {
          ok: input.outputKey,
          sk: input.spendingKey,
        },
        this.mvk,
      );

      if (hid) {
        let hashId = new Buffer(hid).toString('hex');

        if (hashId && (await this.db.HaveKey(hashId))) {
          return true;
        }
      }
    }

    return false;
  }

  async GetTxKeys(hash, height) {
    let useCache =
      arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : true;
    let txKeys;

    if (useCache) {
      let cacheTx = await this.db.GetTxKeys(hash);

      if (cacheTx) {
        txKeys = cacheTx;
      }
    }

    if (!txKeys) {
      try {
        if (!this.client) return;
        txKeys = await this.client.blockchain_transaction_getKeys(hash);
      } catch (e) {
        this.Log('error getting tx keys '.concat(hash, ': ').concat(e));
        await this.ManageElectrumError(e);
        await sleep(3);
        return await this.GetTxKeys(hash, height, useCache);
      }

      txKeys.txidkeys = hash;

      try {
        await this.db.AddTxKeys(txKeys);
      } catch (e) {}
    }

    let inMine = [];
    let isMine = false;

    for (let i in txKeys.vin) {
      let input = txKeys.vin[i];
      let thisMine = await this.IsMine(input);

      if (thisMine) {
        //await this.GetTx(input.txid, undefined, undefined, false)
        isMine = true;
      }

      inMine.push(thisMine);
    }

    for (let j in txKeys.vout) {
      let output = txKeys.vout[j];
      isMine |= await this.IsMine(output);
    }

    if (isMine) {
      await this.QueueTx(hash, inMine, height, true);
    } else {
      await this.db.MarkAsFetched(hash);
    }

    txKeys.txid = hash;
    return txKeys;
  }

  async DeriveSpendingKeyFromStringHash(prefix, name, spendingPassword) {
    if (typeof name === 'string') {
      name = _bitcoreLib.default.crypto.Hash.sha256sha256(
        Buffer.concat([new Buffer([name.length]), new Buffer(name, 'utf-8')]),
      );
    }

    if (!name.reverse) {
      throw new Error(
        'name should be of type string but it is '.concat(typeof name),
      );
    }

    let sh = prefix + name.reverse().toString('hex');

    let hash = _bitcoreLib.default.crypto.Hash.sha256sha256(
      Buffer.concat([new Buffer([sh.length]), new Buffer(sh, 'utf-8')]),
    );

    let msk = await this.GetMasterSpendKey(spendingPassword);
    if (!msk) return;
    msk = new Buffer(msk.serialize());
    let ret = new Buffer(32);
    msk.copy(ret, 32 - msk.length);

    for (let i = 0; i < 8; i++) {
      let index =
        ((hash[i * 4] << 24) |
          (hash[i * 4 + 1] << 16) |
          (hash[i * 4 + 2] << 8) |
          hash[i * 4 + 3]) >>>
        0;
      msk = blsct.DeriveChildSK(ret, index);
      msk.copy(ret, 32 - msk.length);
    }

    let retFr = new blsct.mcl.Fr();
    retFr.setLittleEndianMod(new Uint8Array(ret));
    return retFr.serialize();
  }

  async xNavCreateTransactionMultiple(dest, spendingPassword) {
    let subtractFee =
      arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : false;
    let tokenId =
      arguments.length > 3 && arguments[3] !== undefined
        ? arguments[3]
        : new Buffer(new Uint8Array(32));
    let tokenNftId =
      arguments.length > 4 && arguments[4] !== undefined ? arguments[4] : -1;
    let mvk = this.mvk;
    let msk = await this.GetMasterSpendKey(spendingPassword);
    if (!(msk && mvk)) return;
    let utx = await this.GetUtxos(_output_types.default.XNAV);
    let utxos = [];

    for (const out_i in utx) {
      let out = utx[out_i];
      if (!(out.output.isCt() || out.output.isNft())) continue;
      utxos.push(out);
    }

    if (!utxos.length) throw new Error('No available xNAV outputs');

    for (let i in dest) {
      if (
        typeof dests[i].dest === 'string' &&
        dest[i].dest.substring(
          dests[i].dest.length - 4,
          dest[i].dest.length,
        ) === '.nav'
      ) {
        var _await$this$ResolveNa;

        let resolvedDest =
          (_await$this$ResolveNa = (await this.ResolveName(dest[i].dest))[
            '.'
          ]) === null || _await$this$ResolveNa === void 0
            ? void 0
            : _await$this$ResolveNa.nav;
        if (!resolvedDest) throw new Error("Can't resolve " + dest[i].dest);
        dest[i].dest = resolvedDest;
      }
    }

    let tx = await blsct.CreateTransaction(
      utxos,
      dest,
      mvk,
      msk,
      dest.length == 0 && subtractFee,
      tokenId,
      tokenNftId,
    );
    return {
      tx: [tx.toString()],
      fee: tx.feeAmount,
    };
  }

  async xNavCreateTransaction(dest, amount, memo, spendingPassword) {
    let subtractFee =
      arguments.length > 4 && arguments[4] !== undefined ? arguments[4] : true;
    let tokenId =
      arguments.length > 5 && arguments[5] !== undefined
        ? arguments[5]
        : new Buffer(new Uint8Array(32));
    let tokenNftId =
      arguments.length > 6 && arguments[6] !== undefined ? arguments[6] : -1;
    let vData =
      arguments.length > 7 && arguments[7] !== undefined
        ? arguments[7]
        : new Buffer([]);
    let extraKey =
      arguments.length > 8 && arguments[8] !== undefined
        ? arguments[8]
        : undefined;
    let extraIn =
      arguments.length > 9 && arguments[9] !== undefined ? arguments[9] : 0;
    let aggFee =
      arguments.length > 10 && arguments[10] !== undefined ? arguments[10] : 0;
    let from =
      arguments.length > 11 && arguments[11] !== undefined ? arguments[11] : [];
    let useFullAmount =
      arguments.length > 12 && arguments[12] !== undefined
        ? arguments[12]
        : false;

    if (typeof tokenId === 'string') {
      return await this.xNavCreateTransaction(
        dest,
        amount,
        memo,
        spendingPassword,
        subtractFee,
        Buffer.from(tokenId, 'hex'),
        tokenNftId,
        vData,
        extraKey,
        extraIn,
        aggFee,
      );
    }

    if (amount < 0) throw new TypeError('Amount must be positive');
    let mvk = this.mvk;
    let msk = await this.GetMasterSpendKey(spendingPassword);
    if (!(msk && mvk)) return;
    let utx = await this.GetUtxos(_output_types.default.XNAV);
    let utxos = [];
    let utxoAmount = 0;

    for (const out_i in utx) {
      let out = utx[out_i];
      if (!(out.output.isCt() || out.output.isNft())) continue;
      if (from.length && from.indexOf(out.txid + ':' + out.vout) == -1)
        continue;
      utxoAmount += out.amount ? out.amount : out.satoshis;
      utxos.push(out);
    }

    if (!utxos.length) throw new Error('No available xNAV outputs');

    if (
      typeof dest === 'string' &&
      dest.substring(dest.length - 4, dest.length) === '.nav'
    ) {
      var _await$this$ResolveNa2;

      let resolvedDest =
        (_await$this$ResolveNa2 = (await this.ResolveName(dest))['.']) ===
          null || _await$this$ResolveNa2 === void 0
          ? void 0
          : _await$this$ResolveNa2.nav;
      if (!resolvedDest) throw new Error("Can't resolve " + dest);
      dest = resolvedDest;
    }

    let dests = [
      {
        dest: dest,
        amount: useFullAmount ? utxoAmount : amount,
        memo: memo,
        vData: vData,
        extraKey: extraKey,
      },
    ];
    if (dests.length == 0) subtractFee = false;
    let tx = await blsct.CreateTransaction(
      utxos,
      dests,
      mvk,
      msk,
      useFullAmount ? true : subtractFee,
      tokenId,
      tokenNftId,
      extraIn,
      aggFee,
    );
    return {
      tx: [tx.toString()],
      fee: tx.feeAmount,
    };
  }

  async tokenCreateTransaction(dest, amount, memo, spendingPassword) {
    var _consensus$;

    let tokenId =
      arguments.length > 4 && arguments[4] !== undefined
        ? arguments[4]
        : new Buffer(new Uint8Array(32)).toString('hex');
    let tokenNftId =
      arguments.length > 5 && arguments[5] !== undefined ? arguments[5] : -1;
    let vData =
      arguments.length > 6 && arguments[6] !== undefined
        ? arguments[6]
        : new Buffer([]);
    let extraKey =
      arguments.length > 7 && arguments[7] !== undefined
        ? arguments[7]
        : undefined;
    let ignoreInputs =
      arguments.length > 8 && arguments[8] !== undefined ? arguments[8] : false;
    let ignoreFees =
      arguments.length > 9 && arguments[9] !== undefined ? arguments[9] : false;
    let aggFee =
      arguments.length > 10 && arguments[10] !== undefined ? arguments[10] : 0;
    let from =
      arguments.length > 11 && arguments[11] !== undefined ? arguments[11] : [];
    let useFullAmount =
      arguments.length > 12 && arguments[12] !== undefined
        ? arguments[12]
        : false;
    let consensus = await this.GetConsensusParameters();
    if (
      ((_consensus$ = consensus[24]) === null || _consensus$ === void 0
        ? void 0
        : _consensus$.value) != 1
    )
      throw new Error('Private Tokens and NFTs are not active yet');
    if (amount < 0) throw new TypeError('Amount must be positive');
    tokenId = new Buffer(tokenId, 'hex');
    let mvk = this.mvk;
    let msk = await this.GetMasterSpendKey(spendingPassword);
    if (!(msk && mvk)) return;
    let utx = await this.GetUtxos(_output_types.default.XNAV);
    let utxTok = await this.GetUtxos(
      _output_types.default.XNAV,
      undefined,
      tokenId,
      tokenNftId,
    );
    let utxos = [];
    let utxosTok = [];
    let utxoAmount = 0;

    if (!ignoreInputs) {
      for (const out_i in utx) {
        let out = utx[out_i];
        if (!(out.output.isCt() || out.output.isNft())) continue;
        utxos.push(out);
      }

      for (const out_i in utxTok) {
        let out = utxTok[out_i];
        if (!(out.output.isCt() || out.output.isNft())) continue;
        if (from.length && from.indexOf(out.txid + ':' + out.vout) == -1)
          continue;
        utxoAmount += out.amount ? out.amount : out.satoshis;
        utxosTok.push(out);
      }

      if (!utxos.length) throw new Error('No available xNAV outputs');
      if (
        !utxosTok.length &&
        (!vData.length || (vData.length && vData[0] != 3))
      )
        throw new Error('No available Token outputs');
    }

    let dests = _lodash.default.isArray(dest)
      ? dest
      : [
          {
            dest: dest,
            amount: useFullAmount ? utxoAmount : amount,
            memo: memo,
            vData: vData,
            extraKey: extraKey,
          },
        ];

    for (let i in dests) {
      if (
        typeof dests[i].dest === 'string' &&
        dests[i].dest.substring(
          dests[i].dest.length - 4,
          dests[i].dest.length,
        ) === '.nav'
      ) {
        var _await$this$ResolveNa3;

        let resolvedDest =
          (_await$this$ResolveNa3 = (await this.ResolveName(dests[i].dest))[
            '.'
          ]) === null || _await$this$ResolveNa3 === void 0
            ? void 0
            : _await$this$ResolveNa3.nav;
        if (!resolvedDest) throw new Error("Can't resolve " + dests[i].dest);
        dests[i].dest = resolvedDest;
      }
    }

    let txTok = await blsct.CreateTransaction(
      utxosTok,
      dests,
      mvk,
      msk,
      false,
      tokenId,
      tokenNftId,
    );
    let txxNav = !ignoreFees
      ? await blsct.CreateTransaction(
          utxos,
          [],
          mvk,
          msk,
          false,
          new Buffer(new Uint8Array(32)),
          -1,
          txTok.feeAmount,
          aggFee,
        )
      : undefined;
    let toCombine = [txTok.toString()];

    if (!ignoreFees) {
      toCombine.push(txxNav.toString());
    }

    let combinedTx = blsct.CombineTransactions(toCombine);
    return {
      tx: [combinedTx.toString()],
      fee: combinedTx.feeAmount,
    };
  }

  async CreateCancelOrder(order, spendingPassword) {
    const tx = _bitcoreLib.default.Transaction(order.tx[0]);

    if (!tx.inputs[0]) return;
    let prevOutPoint =
      tx.inputs[0].prevTxId.toString('hex') + ':' + tx.inputs[0].outputIndex;
    let prevTx = await this.GetTx(tx.inputs[0].prevTxId.toString('hex'));
    let output = prevTx.tx.outputs[tx.inputs[0].outputIndex];
    let prevTokenId = output.tokenId
      ? Buffer.from(output.tokenId, 'hex')
      : new Buffer(new Uint8Array(32));
    let prevTokenNftId = output.tokenNftId;

    if (
      prevTokenId.toString('hex') ==
      new Buffer(new Uint8Array(32)).toString('hex')
    ) {
      return await this.xNavCreateTransaction(
        (await this.xNavReceivingAddresses(true))[0].address,
        0,
        undefined,
        spendingPassword,
        true,
        new Buffer(new Uint8Array(32)),
        -1,
        undefined,
        undefined,
        0,
        0,
        [prevOutPoint],
        true,
      );
    } else {
      return await this.tokenCreateTransaction(
        (await this.xNavReceivingAddresses(true))[0].address,
        0,
        undefined,
        spendingPassword,
        prevTokenId,
        prevTokenNftId,
        undefined,
        undefined,
        false,
        false,
        0,
        [prevOutPoint],
        true,
      );
    }
  }

  async VerifyOrder(order) {
    if (!this.client) return;

    const tx = _bitcoreLib.default.Transaction(order.tx[0]);

    let valueKey;

    for (let input of tx.inputs) {
      let currentStatus = await this.client.blockchain_outpoint_subscribe(
        input.prevTxId.toString('hex'),
        input.outputIndex,
      );
      await this.client.blockchain_outpoint_unsubscribe(
        input.prevTxId.toString('hex'),
        input.outputIndex,
      );
      if (currentStatus && currentStatus.spender_txhash)
        throw new Error('Inputs are spent');
      let prevTx = await this.GetTx(input.prevTxId.toString('hex'));
      let output = prevTx.tx.outputs[input.outputIndex];
      blsct.H(output.tokenId, parseInt(output.tokenNftId.toString()));

      if (output.isCt()) {
        if (!valueKey) valueKey = output.bp.V[0];
        else valueKey = blsct.mcl.add(valueKey, output.bp.V[0]);
      } else {
        let vFr = new blsct.mcl.Fr();
        vFr.setInt(output.amount ? output.amount : output.satoshis);
        let vComm = blsct.mcl.mul(
          blsct.H(output.tokenId, parseInt(output.tokenNftId.toString())),
          vFr,
        );
        if (!valueKey) valueKey = vComm;
        else valueKey = blsct.mcl.add(valueKey, vComm);
      }
    }

    for (let output of order.pay) {
      blsct.H(output.tokenId, output.tokenNftId);
      let vFr = new blsct.mcl.Fr();
      vFr.setInt(output.amount ? output.amount : output.satoshis);
      let vComm = blsct.mcl.mul(
        blsct.H(output.tokenId, output.tokenNftId),
        vFr,
      );
      if (!valueKey) valueKey = vComm;
      else valueKey = blsct.mcl.add(valueKey, vComm);
    }

    for (let output of order.receive) {
      blsct.H(output.tokenId, output.tokenNftId);
      let vFr = new blsct.mcl.Fr();
      vFr.setInt(output.amount ? output.amount : output.satoshis);
      let vComm = blsct.mcl.mul(
        blsct.H(output.tokenId, output.tokenNftId),
        vFr,
      );
      if (!valueKey) valueKey = blsct.mcl.inv(vComm);
      else valueKey = blsct.mcl.sub(valueKey, vComm);
    }

    for (let output of tx.outputs) {
      blsct.H(output.tokenId, parseInt(output.tokenNftId.toString()));

      if (output.isCt()) {
        if (!valueKey) valueKey = blsct.mcl.inv(output.bp.V[0]);
        else valueKey = blsct.mcl.sub(valueKey, output.bp.V[0]);
      } else {
        let vFr = new blsct.mcl.Fr();
        vFr.setInt(output.amount ? output.amount : output.satoshis);
        let vComm = blsct.mcl.mul(
          blsct.H(output.tokenId, parseInt(output.tokenNftId.toString())),
          vFr,
        );
        if (!valueKey) valueKey = blsct.mcl.inv(vComm);
        else valueKey = blsct.mcl.sub(valueKey, vComm);
      }
    }

    return blsct.BalanceSigVerify(valueKey, tx.vchbalsig);
  }

  async SendTransaction(txs) {
    if (_lodash.default.isArray(txs)) {
      let ret = [];

      for (const i in txs) {
        let tx = txs[i];

        try {
          let hash = await this.SendTransactionSingle(tx);
          ret.push(hash);
        } catch (e) {
          console.error('error sending tx: '.concat(e));
          await this.ManageElectrumError(e);
          return {
            hashes: ret,
            error: e,
          };
        }
      }

      return {
        hashes: ret,
        error: undefined,
      };
    } else {
      try {
        return {
          hashes: [await this.SendTransactionSingle(txs)],
          error: undefined,
        };
      } catch (e) {
        console.error('error sending tx: '.concat(e));
        await this.ManageElectrumError(e);
        return {
          hashes: [],
          error: e,
        };
      }
    }
  }

  async SendTransactionSingle(tx) {
    if (!this.client) return;
    let ret = await this.client.blockchain_transaction_broadcast(tx);

    let txObj = _bitcoreLib.default.Transaction(tx);

    let tx_ = {
      txid: ret,
      hex: tx,
    };

    try {
      await this.db.AddTx(tx_);
    } catch (e) {
      console.log('AddTx', e);
    }

    tx_.tx = txObj;
    await this.ProcessTx(tx_);
    return ret;
  }

  Encrypt(plain, key) {
    const iv = crypto.randomBytes(16);
    const aes = crypto.createCipheriv('aes-256-cbc', key, iv);
    let ciphertext = aes.update(plain);
    ciphertext = Buffer.concat([iv, ciphertext, aes.final()]);
    return ciphertext;
  }

  Decrypt(cypher, key) {
    const ciphertextBytes = Buffer.from(cypher);
    const iv = ciphertextBytes.slice(0, 16);
    const data = ciphertextBytes.slice(16);
    const aes = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let plaintextBytes = Buffer.from(aes.update(data));
    plaintextBytes = Buffer.concat([plaintextBytes, aes.final()]);
    return plaintextBytes;
  }

  async RegisterName(name, spendingPassword) {
    name = name.toLowerCase();
    let nameResolve = {};

    try {
      nameResolve = await this.ResolveName(name);
    } catch (e) {}

    if (nameResolve['_key']) throw new Error('Name is already registered');
    let derived = await this.DeriveSpendingKeyFromStringHash(
      'name/',
      name,
      spendingPassword,
    );
    let key = blsct.SkToPubKey(new Buffer(derived).toString('hex'));
    let sh = name + key.serializeToHexStr();

    let nameHash = _bitcoreLib.default.crypto.Hash.sha256sha256(
      Buffer.concat([new Buffer([sh.length]), new Buffer(sh, 'utf-8')]),
    );

    let bufferHash = new Buffer(nameHash);
    let bk = new blsct.mcl.Fr();
    bk.setByCSPRNG();
    let destViewKey = blsct.SkToPubKey(this.mvk);
    let nonce = blsct.mcl.mul(destViewKey, bk);

    let encryptKey = _bitcoreLib.default.crypto.Blsct.HashG1Element(nonce, 1);

    let encryptedName = this.Encrypt(
      name + ';' + key.serializeToHexStr(),
      encryptKey,
    );
    let vData = Buffer.concat([
      new Buffer([6, 0, 0, 0]),
      bufferHash,
      new Buffer(blsct.SkToPubKey(bk).serialize()),
      encryptedName,
    ]);
    return await this.xNavCreateTransaction(
      _bitcoreLib.default.Script.fromHex('6ac1'),
      0,
      '',
      spendingPassword,
      false,
      new Buffer(new Uint8Array(32)),
      -1,
      vData,
    );
  }

  async CreateToken(name, token_code, token_supply, spendingPassword) {
    var _consensus$2;

    let consensus = await this.GetConsensusParameters();
    if (
      ((_consensus$2 = consensus[24]) === null || _consensus$2 === void 0
        ? void 0
        : _consensus$2.value) != 1
    )
      throw new Error('Private Tokens and NFTs are not active yet');
    let derived = await this.DeriveSpendingKeyFromStringHash(
      'token/',
      name + token_code,
      spendingPassword,
    );
    let key = blsct.SkToPubKey(new Buffer(derived).toString('hex'));
    let vData = Buffer.concat([
      new Buffer([2, 0, 0, 0, 48]),
      new Buffer(key.serialize()),
      new Buffer(_bitcoreLib.default.encoding.Varint(name.length).buf),
      new Buffer(name, 'utf-8'),
      new Buffer([0, 0, 0, 0, 0, 0, 0, 0]),
      new Buffer(_bitcoreLib.default.encoding.Varint(token_code.length).buf),
      new Buffer(token_code, 'utf-8'),
      new Buffer(
        _bitcoreLib.default.crypto.Blsct.bytesArray(token_supply).reverse(),
      ),
    ]);
    let ret = await this.xNavCreateTransaction(
      _bitcoreLib.default.Script.fromHex('6ac1'),
      0,
      '',
      spendingPassword,
      false,
      new Buffer(new Uint8Array(32)),
      -1,
      vData,
      derived,
    );
    ret.token_id = new Buffer(
      _bitcoreLib.default.crypto.Hash.sha256sha256(
        Buffer.concat([new Buffer([48]), new Buffer(key.serialize())]),
      ),
    )
      .reverse()
      .toString('hex');

    try {
      await this.db.AddKey(
        ret.token_id.toString('hex'),
        key.serialize().toString('hex'),
        _address_types.default.TOKEN,
        name,
        false,
        false,
        token_code,
        spendingPassword,
      );
    } catch (e) {
      console.log(e.message);
    }

    return ret;
  }

  async MintToken(id, dest, amount, spendingPassword) {
    var _consensus$3;

    let consensus = await this.GetConsensusParameters();
    if (
      ((_consensus$3 = consensus[24]) === null || _consensus$3 === void 0
        ? void 0
        : _consensus$3.value) != 1
    )
      throw new Error('Private Tokens and NFTs are not active yet');
    let token = await this.GetTokenInfo(id);
    if (!token || (token && token.name == undefined))
      throw new Error('Unknown token');
    let derived = await this.DeriveSpendingKeyFromStringHash(
      'token/',
      token.name + token.code,
      spendingPassword,
    );
    let key = blsct.SkToPubKey(new Buffer(derived).toString('hex'));
    if (new Buffer(token.key).toString('hex') != key.serializeToHexStr())
      throw new Error("You don't own the token");
    let vData = Buffer.concat([
      new Buffer([3, 0, 0, 0, 48]),
      new Buffer(key.serialize()),
      new Buffer(_bitcoreLib.default.crypto.Blsct.bytesArray(amount).reverse()),
      new Buffer([0]),
    ]);
    return await this.tokenCreateTransaction(
      dest,
      amount,
      '',
      spendingPassword,
      id,
      -1,
      vData,
      derived,
    );
  }

  async CreateNft(name, scheme, token_supply, spendingPassword) {
    var _consensus$4;

    let consensus = await this.GetConsensusParameters();
    if (
      ((_consensus$4 = consensus[24]) === null || _consensus$4 === void 0
        ? void 0
        : _consensus$4.value) != 1
    )
      throw new Error('Private Tokens and NFTs are not active yet');
    let derived = await this.DeriveSpendingKeyFromStringHash(
      'token/',
      name + scheme,
      spendingPassword,
    );
    let key = blsct.SkToPubKey(new Buffer(derived).toString('hex'));
    let sh = name + key.serializeToHexStr();

    let nameHash = _bitcoreLib.default.crypto.Hash.sha256sha256(
      Buffer.concat([new Buffer([sh.length]), new Buffer(sh, 'utf-8')]),
    );

    let bufferHash = new Buffer(nameHash);
    let vData = Buffer.concat([
      new Buffer([2, 0, 0, 0, 48]),
      new Buffer(key.serialize()),
      new Buffer(_bitcoreLib.default.encoding.Varint(name.length).buf),
      new Buffer(name, 'utf-8'),
      new Buffer([1, 0, 0, 0, 0, 0, 0, 0]),
      new Buffer(_bitcoreLib.default.encoding.Varint(scheme.length).buf),
      new Buffer(scheme, 'utf-8'),
      new Buffer(
        _bitcoreLib.default.crypto.Blsct.bytesArray(token_supply).reverse(),
      ),
    ]);
    let ret = await this.xNavCreateTransaction(
      _bitcoreLib.default.Script.fromHex('6ac1'),
      0,
      '',
      spendingPassword,
      false,
      new Buffer(new Uint8Array(32)),
      -1,
      vData,
      derived,
    );
    ret.token_id = new Buffer(
      _bitcoreLib.default.crypto.Hash.sha256sha256(
        Buffer.concat([new Buffer([48]), new Buffer(key.serialize())]),
      ),
    )
      .reverse()
      .toString('hex');

    try {
      await this.db
        .AddKey(
          ret.token_id.toString('hex'),
          key.serialize().toString('hex'),
          _address_types.default.TOKEN,
          name,
          false,
          false,
          scheme,
          spendingPassword,
        )
        .catch();
    } catch (e) {
      console.log(e.message);
    }

    return ret;
  }

  async CreateNftProof(id, nftid, spendingPassword) {
    if (!this.client) throw new Error('Not connected');
    let utxTok = await this.GetUtxos(
      _output_types.default.XNAV,
      undefined,
      id,
      nftid,
    );
    let nftInfo = await this.client.blockchain_token_getNft(
      id,
      parseInt(nftid),
      true,
    );
    let hash = nftInfo.nfts[0].utxo.hash;
    let n = nftInfo.nfts[0].utxo.n;
    let prevOut = utxTok.filter(
      (el) =>
        parseInt(n) == parseInt(el.vout) &&
        el.txid == nftInfo.nfts[0].utxo.hash,
    );
    if (prevOut.length == 0) throw new Error("You don't own the NFT");
    let mvk = this.mvk;
    let msk = await this.GetMasterSpendKey(spendingPassword);
    if (!(msk && mvk)) throw new Error('Wrong spending password');
    blsct.RecoverBLSCTOutput(
      prevOut[0].output,
      mvk,
      msk,
      prevOut[0].accIndex[0],
      prevOut[0].accIndex[1],
    );
    let msg =
      constants.NFT_PROOF_PREFIX +
      '_' +
      id +
      '_' +
      nftid +
      '_' +
      hash +
      '_' +
      n;
    let hashedMsg = (0, _hash.sha256sha256)(Buffer.from(msg, 'utf-8'));
    let sig = await blsct.AugmentedSign(prevOut[0].output.sigk, hashedMsg);
    return {
      tokenId: id,
      nftId: nftid,
      sig: sig,
    };
  }

  async VerifyNftProof(id, nftid, proof) {
    if (!this.client) throw new Error('Not connected');
    let nftInfo = await this.client.blockchain_token_getNft(
      id,
      parseInt(nftid),
      true,
    );
    let hash = nftInfo.nfts[0].utxo.hash;
    let n = nftInfo.nfts[0].utxo.n;
    let msg =
      constants.NFT_PROOF_PREFIX +
      '_' +
      id +
      '_' +
      nftid +
      '_' +
      hash +
      '_' +
      n;
    let hashedMsg = (0, _hash.sha256sha256)(Buffer.from(msg, 'utf-8'));
    let sigResult = await blsct.AugmentedVerify(
      nftInfo.nfts[0].utxo.spendingKey,
      hashedMsg,
      proof.sig,
    );
    return {
      txid: hash,
      nout: n,
      result: sigResult,
    };
  }

  async MintNft(id, nftid, dest, metadata, spendingPassword) {
    var _consensus$5;

    let consensus = await this.GetConsensusParameters();
    if (
      ((_consensus$5 = consensus[24]) === null || _consensus$5 === void 0
        ? void 0
        : _consensus$5.value) != 1
    )
      throw new Error('Private Tokens and NFTs are not active yet');
    let token = await this.GetTokenInfo(id);
    if (!token || (token && token.name == undefined))
      throw new Error('Unknown token');
    let derived = await this.DeriveSpendingKeyFromStringHash(
      'token/',
      token.name + token.code,
      spendingPassword,
    );
    let key = blsct.SkToPubKey(new Buffer(derived).toString('hex'));
    if (new Buffer(token.key).toString('hex') != key.serializeToHexStr())
      throw new Error("You don't own the token");
    let vData = Buffer.concat([
      new Buffer([3, 0, 0, 0, 48]),
      new Buffer(key.serialize()),
      new Buffer(_bitcoreLib.default.crypto.Blsct.bytesArray(nftid).reverse()),
      new Buffer(_bitcoreLib.default.encoding.Varint(metadata.length).buf),
      new Buffer(new Buffer(metadata, 'utf-8')),
    ]);
    return await this.tokenCreateTransaction(
      dest,
      1,
      '',
      spendingPassword,
      id,
      nftid,
      vData,
      derived,
    );
  }

  async AcceptOrder(order, spendingPassword) {
    let mvk = this.mvk;
    let msk = await this.GetMasterSpendKey(spendingPassword);
    if (!(msk && mvk)) throw new Error('Wrong spending password');

    for (let i in order.pay) {
      if (!order.pay[i].tokenId)
        order.pay[i].tokenId = new Buffer(new Uint8Array(32));
      if (!Buffer.isBuffer(order.receive[i].tokenId))
        order.pay[i].tokenId = new Buffer(order.pay[i].tokenId, 'hex');
      if (!order.pay[i].tokenNftId === undefined) order.pay[i].tokenNftId = -1;
    }

    for (let i in order.receive) {
      if (!order.receive[i].tokenId)
        order.receive[i].tokenId = new Buffer(new Uint8Array(32));
      if (!Buffer.isBuffer(order.receive[i].tokenId))
        order.receive[i].tokenId = new Buffer(order.receive[i].tokenId, 'hex');
      if (!order.receive[i].tokenNftId === undefined)
        order.receive[i].tokenNftId = -1;
    }

    let utxos = await this.GetUtxos(
      _output_types.default.XNAV,
      undefined,
      order.pay[0].tokenId,
      order.pay[0].tokenNftId,
    );
    let dests = [
      {
        dest: _bitcoreLib.default.Script.fromHex('6a'),
        amount: order.pay[0].amount,
        tokenId: order.pay[0].tokenId,
        tokenNftId: order.pay[0].tokenNftId,
        ignore: true,
      },
      {
        dest: (await this.xNavReceivingAddresses(true))[0].address,
        amount: order.receive[0].amount,
        tokenId: order.receive[0].tokenId,
        tokenNftId: order.receive[0].tokenNftId,
      },
    ];

    for (let i in dests) {
      if (
        typeof dests[i].dest === 'string' &&
        dests[i].dest.substring(
          dests[i].dest.length - 4,
          dests[i].dest.length,
        ) === '.nav'
      ) {
        var _await$this$ResolveNa4;

        let resolvedDest =
          (_await$this$ResolveNa4 = (await this.ResolveName(dests[i].dest))[
            '.'
          ]) === null || _await$this$ResolveNa4 === void 0
            ? void 0
            : _await$this$ResolveNa4.nav;
        if (!resolvedDest) throw new Error("Can't resolve " + dests[i].dest);
        dests[i].dest = resolvedDest;
      }
    }

    let takeTx = await blsct.CreateTransaction(
      utxos,
      dests,
      mvk,
      msk,
      false,
      order.pay[0].tokenId,
      order.pay[0].tokenNftId,
    );
    let combinedTx = blsct.CombineTransactions([
      takeTx.toString(),
      order.tx[0],
    ]);
    return {
      tx: combinedTx.toString(),
      fee: combinedTx.feeAmount,
    };
  }

  async CreateMintNftOrder(id, nftid, payTo, price) {
    let metadata =
      arguments.length > 4 && arguments[4] !== undefined ? arguments[4] : '';
    let spendingPassword = arguments.length > 5 ? arguments[5] : undefined;
    let token = await this.GetTokenInfo(id);
    if (!token || (token && token.name == undefined))
      throw new Error('Unknown token');
    let derived = await this.DeriveSpendingKeyFromStringHash(
      'token/',
      token.name + token.code,
      spendingPassword,
    );
    let key = blsct.SkToPubKey(new Buffer(derived).toString('hex'));
    if (new Buffer(token.key).toString('hex') != key.serializeToHexStr())
      throw new Error("You don't own the token");
    let vData = Buffer.concat([
      new Buffer([3, 0, 0, 0, 48]),
      new Buffer(key.serialize()),
      new Buffer(_bitcoreLib.default.crypto.Blsct.bytesArray(nftid).reverse()),
      new Buffer(_bitcoreLib.default.encoding.Varint(metadata.length).buf),
      new Buffer(new Buffer(metadata, 'utf-8')),
    ]);
    return {
      tx: (
        await this.tokenCreateTransaction(
          [
            {
              dest: payTo,
              amount: price,
              memo: ''
                .concat(token.name.substr(0, 20), ' ')
                .concat(nftid, ' mint'),
              tokenId: new Buffer(new Uint8Array(32)).toString('hex'),
              tokenNftId: -1,
            },
            {
              dest: _bitcoreLib.default.Script.fromHex('6ac1'),
              amount: 0,
              vData: vData,
              extraKey: derived,
              tokenId: new Buffer(id, 'hex'),
              tokenNftId: nftid,
            },
          ],
          1,
          '',
          spendingPassword,
          id,
          nftid,
          undefined,
          derived,
          true,
          true,
        )
      ).tx,
      pay: [
        {
          amount: price,
        },
      ],
      receive: [
        {
          amount: 1,
          tokenId: id,
          tokenNftId: nftid,
        },
      ],
    };
  }

  async CreateSellNftOrder(id, nftid, payTo, price, spendingPassword) {
    let token = await this.GetTokenInfo(id);
    if (!token || (token && token.name == undefined))
      throw new Error('Unknown token');
    return {
      tx: (
        await this.tokenCreateTransaction(
          [
            {
              dest: payTo,
              amount: 1,
              memo: '',
              tokenId: new Buffer(id, 'hex'),
              tokenNftId: nftid,
              ignore: true,
            },
            {
              dest: payTo,
              amount: price,
              memo: ''
                .concat(token.name.substr(0, 20), ' ')
                .concat(nftid, ' sale'),
              tokenId: new Buffer(new Uint8Array(32)).toString('hex'),
              tokenNftId: -1,
            },
          ],
          1,
          '',
          spendingPassword,
          id,
          nftid,
          undefined,
          undefined,
          false,
          true,
        )
      ).tx,
      pay: [
        {
          amount: price,
        },
      ],
      receive: [
        {
          amount: 1,
          tokenId: id,
          tokenNftId: nftid,
        },
      ],
    };
  }

  async CreateBuyNftOrder(id, nftid, payTo, price, spendingPassword) {
    let token = await this.GetTokenInfo(id);
    if (!token || (token && token.name == undefined))
      throw new Error('Unknown token');
    return {
      tx: (
        await this.tokenCreateTransaction(
          [
            {
              dest: payTo,
              amount: price,
              memo: '',
              tokenId: new Buffer(new Uint8Array(32)).toString('hex'),
              tokenNftId: -1,
              ignore: true,
            },
            {
              dest: payTo,
              amount: 1,
              memo: ''
                .concat(token.name.substr(0, 20), ' ')
                .concat(nftid, ' purchase'),
              tokenId: new Buffer(id, 'hex'),
              tokenNftId: nftid,
            },
          ],
          1,
          '',
          spendingPassword,
          new Buffer(new Uint8Array(32)).toString('hex'),
          -1,
          undefined,
          undefined,
          false,
          true,
        )
      ).tx,
      pay: [
        {
          amount: 1,
          tokenId: id,
          tokenNftId: nftid,
        },
      ],
      receive: [
        {
          amount: price,
        },
      ],
    };
  }

  async CreateTokenOrder(
    tokenInId,
    tokenInAmount,
    payTo,
    tokenOutId,
    tokenOutAmount,
    spendingPassword,
  ) {
    let tokenIn = {
      name: 'xNAV',
    };
    let tokenOut = {
      name: 'xNAV',
    };
    tokenInId = tokenInId
      ? tokenInId
      : new Buffer(new Uint8Array(32)).toString('hex');
    tokenOutId = tokenOutId
      ? tokenOutId
      : new Buffer(new Uint8Array(32)).toString('hex');
    if (tokenInId == tokenOutId)
      throw new Error('tokenInId and tokenOutId must be different');

    if (tokenInId != new Buffer(new Uint8Array(32)).toString('hex')) {
      tokenIn = await this.GetTokenInfo(tokenInId);
      if (!tokenIn || (tokenIn && tokenIn.name == undefined))
        throw new Error('Unknown tokenInId');
    }

    if (tokenOutId != new Buffer(new Uint8Array(32)).toString('hex')) {
      tokenOut = await this.GetTokenInfo(tokenOutId);
      if (!tokenOut || (tokenOut && tokenOut.name == undefined))
        throw new Error('Unknown tokenInId');
    }

    return {
      tx: (
        await this.tokenCreateTransaction(
          [
            {
              dest: payTo,
              amount: tokenOutAmount,
              memo: '',
              tokenId: Buffer.from(tokenOutId, 'hex'),
              tokenNftId: -1,
              ignore: true,
            },
            {
              dest: payTo,
              amount: tokenInAmount,
              memo: ''
                .concat(tokenIn.name.substr(0, 10), '/')
                .concat(tokenOut.name.substr(0, 10), ' trade'),
              tokenId: Buffer.from(tokenInId, 'hex'),
              tokenNftId: -1,
            },
          ],
          tokenOutAmount,
          '',
          spendingPassword,
          Buffer.from(tokenOutId, 'hex'),
          -1,
          undefined,
          undefined,
          false,
          true,
        )
      ).tx,
      pay: [
        {
          amount: tokenInAmount,
          tokenId: tokenInId,
        },
      ],
      receive: [
        {
          amount: tokenOutAmount,
          tokenId: tokenOutId,
        },
      ],
    };
  }

  async UpdateName(name, subdomain, key, value, spendingPassword) {
    let consensus = await this.GetConsensusParameters();
    if (!consensus[22]) throw new Error('Could not read consensus parameters');
    let first = false;
    let size = 0;
    let nameResolve = {};
    name = name.toLowerCase();

    try {
      nameResolve = await this.ResolveName(name, true);

      if (Object.keys(nameResolve) && Object.keys(nameResolve).length == 0) {
        first = true;
      } else {
        for (var key_ in nameResolve) {
          if (_lodash.default.isString(nameResolve[key_]))
            size += key_.length + nameResolve[key_].length;
          else {
            for (var key_2 in nameResolve[key_]) {
              if (_lodash.default.isString(nameResolve[key_][key_2]))
                size += key_2.length + nameResolve[key_][key_2].length;
            }
          }
        }
      }
    } catch (e) {
      console.log(e);
      first = true;
    }

    size += key.length + value.length;
    let privk = await this.DeriveSpendingKeyFromStringHash(
      'name/',
      name,
      spendingPassword,
    );
    let k = blsct.SkToPubKey(new Buffer(privk).toString('hex'));
    if (!first && k.serializeToHexStr() != nameResolve['_key'])
      throw new Error("You don't own the name.");
    let fee =
      (first ? consensus[22].value : 0) +
      Math.floor(size / consensus[26].value) * consensus[27].value;
    let vData = Buffer.concat([
      new Buffer([first ? 7 : 8, 0, 0, 0]),
      new Buffer([name.length]),
      new Buffer(name, 'utf-8'),
      new Buffer([48]),
      new Buffer(k.serialize()),
      new Buffer([subdomain.length]),
      new Buffer(subdomain, 'utf-8'),
      new Buffer([key.length]),
      new Buffer(key, 'utf-8'),
      new Buffer([value.length]),
      new Buffer(value, 'utf-8'),
      new Buffer(privk),
    ]);
    let ret = await this.xNavCreateTransaction(
      _bitcoreLib.default.Script.fromHex('6ac1'),
      fee,
      '',
      spendingPassword,
      false,
      new Buffer(new Uint8Array(32)),
      -1,
      vData,
      privk,
    );
    ret.fee += fee;
    return ret;
  }

  async NavCreateTransaction(dest, amount, memo, spendingPassword) {
    let subtractFee =
      arguments.length > 4 && arguments[4] !== undefined ? arguments[4] : true;
    let fee =
      arguments.length > 5 && arguments[5] !== undefined
        ? arguments[5]
        : 100000;
    let type =
      arguments.length > 6 && arguments[6] !== undefined
        ? arguments[6]
        : _output_types.default.NAV;
    let fromAddress =
      arguments.length > 7 && arguments[7] !== undefined
        ? arguments[7]
        : undefined;
    let ret =
      arguments.length > 8 && arguments[8] !== undefined
        ? arguments[8]
        : {
            fee: 0,
            tx: [],
          };
    let selectxnav =
      arguments.length > 9 && arguments[9] !== undefined ? arguments[9] : false;
    if (amount <= 0) throw new TypeError('Amount must be greater than 0');

    if (!(dest instanceof _bitcoreLib.default.Address)) {
      if (
        typeof dest === 'string' &&
        dest.substring(dest.length - 4, dest.length) === '.nav'
      ) {
        var _await$this$ResolveNa5;

        let resolvedDest =
          (_await$this$ResolveNa5 = (await this.ResolveName(dest))['.']) ===
            null || _await$this$ResolveNa5 === void 0
            ? void 0
            : _await$this$ResolveNa5.nav;
        if (!resolvedDest) throw new Error("Can't resolve " + dest);
        dest = resolvedDest;
      }

      return await this.NavCreateTransaction(
        new _bitcoreLib.default.Address(dest),
        amount,
        memo,
        spendingPassword,
        subtractFee,
        fee,
        type,
        fromAddress,
        ret,
        selectxnav,
      );
    }

    let msk = await this.GetMasterKey('xNavSpend', spendingPassword);
    if (!msk) return;
    let utxos = await this.GetUtxos(type, fromAddress);

    let tx = _bitcoreLib.default.Transaction();

    let addedInputs = 0;
    let privateKeys = [];
    let gammaIns = new blsct.mcl.Fr();

    for (let u in utxos) {
      let out = utxos[u];
      if (out.output.isCt() || out.output.isNft())
        throw new TypeError('NavSend can only spend nav outputs');
      let prevtx = await this.GetTx(out.txid);
      if (prevtx.tx.outputs[out.vout].hasBlsctKeys() && !selectxnav) continue;
      if (!prevtx.tx.outputs[out.vout].hasBlsctKeys() && selectxnav) continue;

      let utxo = _bitcoreLib.default.Transaction.UnspentOutput({
        txid: out.txid,
        vout: parseInt(out.vout),
        scriptPubKey: out.output.script,
        satoshis: out.output.satoshis,
      });

      let hashId = new Buffer(
        out.output.script.isPublicKeyOut()
          ? ripemd160(sha256(out.output.script.getPublicKey()))
          : out.output.script.getPublicKeyHash(),
      ).toString('hex');
      let privK = await this.GetPrivateKey(hashId, spendingPassword);

      if (privK) {
        addedInputs += out.output.satoshis;
        tx.from(utxo);
        privateKeys.push(privK);
      }

      if (privK && addedInputs >= amount + (subtractFee ? 0 : fee)) break;
    }

    if (addedInputs < amount + (subtractFee ? 0 : fee)) {
      if (selectxnav) {
        throw new Error(
          'Not enough balance (required '
            .concat(amount + (subtractFee ? 0 : fee), ', selected ')
            .concat(addedInputs, ')'),
        );
      } else {
        await this.NavCreateTransaction(
          dest,
          amount + (subtractFee ? 0 : fee) - addedInputs,
          memo,
          spendingPassword,
          subtractFee,
          fee,
          type,
          fromAddress,
          ret,
          true,
        );
        amount = addedInputs;
      }
    }

    if (dest.isXnav()) {
      if (amount >= (subtractFee ? fee : 0)) {
        let out = await blsct.CreateBLSCTOutput(
          dest,
          amount - (subtractFee ? fee : 0),
          memo,
        );
        tx.addOutput(out);
        await blsct.SigBalance(tx, blsct.mcl.sub(gammaIns, out.gamma));
        tx.addOutput(
          new _bitcoreLib.default.Transaction.Output({
            satoshis: fee,
            script: _bitcoreLib.default.Script.fromHex('6a'),
          }),
        );
      }
    } else {
      if (amount >= (subtractFee ? fee : 0)) {
        tx.to(dest, amount - (subtractFee ? fee : 0));
      }

      tx.strdzeel = memo;
    }

    if (addedInputs - (amount + (subtractFee ? 0 : fee)) > 0) {
      if (type == 0x2 && fromAddress) {
        tx.to(
          _bitcoreLib.default.Address.fromBuffers(
            [
              new Buffer([
                _bitcoreLib.default.Networks[this.network].coldstaking,
              ]),
              _bitcoreLib.default.Address(fromAddress).toBuffer().slice(1),
              _bitcoreLib.default
                .Address((await this.NavReceivingAddresses())[0].address)
                .toBuffer()
                .slice(1),
            ],
            this.network,
            'coldstaking',
          ),
          addedInputs - (amount + (subtractFee ? 0 : fee)),
        );
      } else {
        tx.to(
          (await this.NavReceivingAddresses())[0].address,
          addedInputs - (amount + (subtractFee ? 0 : fee)),
        );
      }
    }

    tx.settime(Math.floor(Date.now() / 1000)).sign(privateKeys);

    if (tx.inputs.length > 0) {
      ret.fee += fee;
      ret.tx.push(tx.toString());
    }

    return ret;
  }

  async GetPrivateKey(hashId, key) {
    let ret = await this.db.GetKey(hashId, key);
    if (!ret) return;
    return ret.length > 100
      ? _bitcoreLib.default.HDPrivateKey(ret, this.network).privateKey
      : _bitcoreLib.default.PrivateKey(ret);
  }

  async AddCandidate(candidate, network) {
    if (!this.client) return;
    let currentStatus = await this.client.blockchain_outpoint_subscribe(
      candidate.tx.inputs[0].prevTxId.toString('hex'),
      candidate.tx.inputs[0].outputIndex,
    );
    if (
      currentStatus &&
      !currentStatus.spender_txhash &&
      (await this.GetCandidates()).length < 100
    )
      await this.db.AddTxCandidate(candidate, network);
  }

  async NewCandidate(session, candidate) {
    if (this.p2pPool) {
      console.log('New candidate from session ' + session, candidate);
      await this.AddCandidate(
        candidate,
        this.p2pPool.network.name == 'livenet' ? 'mainnet' : 'testnet',
      );
    }
  }
}

exports.WalletFile = WalletFile;
//# sourceMappingURL=wallet.js.map
