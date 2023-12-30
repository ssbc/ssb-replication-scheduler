// SPDX-FileCopyrightText: 2022 Andre 'Staltz' Medeiros
//
// SPDX-License-Identifier: Unlicense

const tape = require('tape')
const ssbKeys = require('ssb-keys')
const path = require('path')
const os = require('os')
const rimraf = require('rimraf')
const caps = require('ssb-caps')
const SecretStack = require('secret-stack')
const pify = require('promisify-4loc')
const sleep = require('util').promisify(setTimeout)

const createSsbServer = SecretStack({ caps })
  .use(require('ssb-db2'))
  .use(require('ssb-db2/compat/ebt'))
  .use(require('ssb-ebt'))
  .use(require('ssb-friends'))
  .use(require('../..'))

const CONNECTION_TIMEOUT = 500 // ms
const REPLICATION_TIMEOUT = 6 * CONNECTION_TIMEOUT

tape('dont request during db2 indexing', async (t) => {
  rimraf.sync(path.join(os.tmpdir(), 'server-alice'))
  rimraf.sync(path.join(os.tmpdir(), 'server-bob'))
  rimraf.sync(path.join(os.tmpdir(), 'server-dolores'))

  const aliceKey = ssbKeys.generate(null, 'alice')
  const alice = createSsbServer({
    path: path.join(os.tmpdir(), 'server-alice'),
    keys: aliceKey,
    timeout: CONNECTION_TIMEOUT,
    replicationScheduler: {
      autostart: true,
      debouncePeriod: 0,
    },
    ebt: {
      logging: true
    }
  })

  const bobKey = ssbKeys.generate(null, 'bob')
  const bob = createSsbServer({
    path: path.join(os.tmpdir(), 'server-bob'),
    keys: bobKey,
    timeout: CONNECTION_TIMEOUT,
    replicationScheduler: {
      autostart: true,
      debouncePeriod: 0,
    },
    ebt: {
      logging: true
    }
  })

  const doloresKey = ssbKeys.generate(null, 'dolores')
  const dolores = createSsbServer({
    path: path.join(os.tmpdir(), 'server-dolores'),
    keys: doloresKey,
    timeout: CONNECTION_TIMEOUT,
    replicationScheduler: {
      autostart: true,
      debouncePeriod: 0,
    },
    ebt: {
      logging: true
    }
  })
  
  await sleep(500)

  t.pass('alice:' + alice.id)
  t.pass('bob:' + bob.id)
  t.pass('dolores:' + dolores.id)

  await Promise.all([
    pify(alice.db.publish)({ type: 'post', text: 'hello A' }),
    pify(bob.db.publish)({ type: 'post', text: 'hello B' }),
    pify(dolores.db.publish)({ type: 'post', text: 'hello D' }),

    pify(alice.db.publish)({
      type: 'contact',
      contact: bob.Id,
      following: true,
    }),
    pify(bob.db.publish)({
      type: 'contact',
      contact: alice.id,
      following: true,
    }),
    pify(dolores.db.publish)({
      type: 'contact',
      contact: bob.id,
      following: true,
    }),

    pify(alice.db.publish)({
      type: 'contact',
      contact: dolores.id,
      following: true,
    }),
    pify(dolores.db.publish)({
      type: 'contact',
      contact: alice.id,
      following: true,
    }),
  ])
  t.pass('published all the messages')

  await sleep(REPLICATION_TIMEOUT)

  await pify(dolores.connect)(alice.getAddress())
  await pify(dolores.connect)(bob.getAddress())

  await sleep(REPLICATION_TIMEOUT)

  await pify(alice.close)(true)
  t.pass('stop alice')

  const restartedAlice = createSsbServer({
    path: path.join(os.tmpdir(), 'server-alice'),
    keys: aliceKey,
    timeout: CONNECTION_TIMEOUT,
    replicationScheduler: {
      autostart: true,
      debouncePeriod: 0,
    },
    ebt: {
      logging: true
    }
  })

  await pify(restartedAlice.db.publish)({
    type: 'contact',
    contact: bob.id,
    blocking: true,
    recps: [alice.id]
  })
  t.pass('published block')

  await sleep(REPLICATION_TIMEOUT)

  await pify(restartedAlice.db.deleteFeed)(bob.id)
  await pify(restartedAlice.db.compact)()
  t.pass('alice removed bob')

  const originalEBTRequest = restartedAlice.ebt.request
  restartedAlice.ebt.request = function request(id, val) {
    if (id === bob.id && val === true)
      t.fail('requested bob, who is blocked')
    else
      t.pass("alice requested:" + id + ", with:" + val)

    originalEBTRequest.call(restartedAlice.ebt, id, val)
  }

  await sleep(500)

  await pify(bob.db.publish)({ type: 'post', text: 'hello B2' })
  t.pass('bob writes another message')

  await sleep(REPLICATION_TIMEOUT)

  await pify(dolores.connect)(bob.getAddress())
  await sleep(REPLICATION_TIMEOUT)
  
  await pify(restartedAlice.db.reset)()
  t.pass('reset indexes')
  
  await pify(dolores.connect)(restartedAlice.getAddress())
  
  await sleep(REPLICATION_TIMEOUT)

  await pify(restartedAlice.close)(true)
  await pify(bob.close)(true)
  await pify(dolores.close)(true)

  t.end()
})
