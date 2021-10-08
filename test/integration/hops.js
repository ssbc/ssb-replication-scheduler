// SPDX-FileCopyrightText: 2021 Andre 'Staltz' Medeiros
//
// SPDX-License-Identifier: Unlicense

const tape = require('tape')
const crypto = require('crypto')
const SecretStack = require('secret-stack')
const pify = require('promisify-4loc')
const path = require('path')
const os = require('os')
const rimraf = require('rimraf')
const sleep = require('util').promisify(setTimeout)
const u = require('../misc/util')

const createSsbServer = SecretStack({
  caps: { shs: crypto.randomBytes(32).toString('base64') },
})
  .use(require('ssb-db'))
  .use(require('ssb-ebt'))
  .use(require('ssb-friends'))
  .use(require('../..'))

const CONNECTION_TIMEOUT = 500 // ms
const REPLICATION_TIMEOUT = 2 * CONNECTION_TIMEOUT
const UNLIMITED = 999

const aliceKeys = u.keysFor('alice')
const bobKeys = u.keysFor('bob')
const carolKeys = u.keysFor('carol')
const davidKeys = u.keysFor('david')

tape('hops 1', async (t) => {
  rimraf.sync(path.join(os.tmpdir(), 'server-alice'))
  rimraf.sync(path.join(os.tmpdir(), 'server-bob'))
  rimraf.sync(path.join(os.tmpdir(), 'server-carol'))
  rimraf.sync(path.join(os.tmpdir(), 'server-david'))

  const alice = createSsbServer({
    path: path.join(os.tmpdir(), 'server-alice'),
    keys: aliceKeys,
    timeout: CONNECTION_TIMEOUT,
    friends: {
      hops: 1,
    },
  })

  const bob = createSsbServer({
    path: path.join(os.tmpdir(), 'server-bob'),
    keys: bobKeys,
    timeout: CONNECTION_TIMEOUT,
    friends: {
      hops: UNLIMITED,
    },
  })

  const carol = createSsbServer({
    path: path.join(os.tmpdir(), 'server-carol'),
    keys: carolKeys,
    timeout: CONNECTION_TIMEOUT,
    friends: {
      hops: UNLIMITED,
    },
  })

  const david = createSsbServer({
    path: path.join(os.tmpdir(), 'server-david'),
    keys: davidKeys,
    timeout: CONNECTION_TIMEOUT,
    friends: {
      hops: UNLIMITED,
    },
  })

  // alice follows bob, bob follows carol, carol follows david
  await Promise.all([
    pify(alice.publish)(u.follow(bob.id)),
    pify(bob.publish)(u.follow(carol.id)),
    pify(carol.publish)(u.follow(david.id)),
    pify(david.publish)({ type: 'post', text: 'hello' }),
  ])

  const [rpcAB, rpcBC, rpcCD] = await Promise.all([
    pify(alice.connect)(bob.getAddress()),
    pify(bob.connect)(carol.getAddress()),
    pify(carol.connect)(david.getAddress()),
  ])

  await sleep(REPLICATION_TIMEOUT)

  // alice => bob -> carol -> david
  const clockAlice = await pify(alice.getVectorClock)()
  t.ok(clockAlice[bob.id], 'alice replicates bob')
  t.notOk(clockAlice[carol.id], 'alice does not replicate carol')
  t.notOk(clockAlice[david.id], 'alice does not replicate david')

  await Promise.all([
    pify(rpcAB.close)(true),
    pify(rpcBC.close)(true),
    pify(rpcCD.close)(true),
  ])

  await Promise.all([
    pify(alice.close)(true),
    pify(bob.close)(true),
    pify(carol.close)(true),
    pify(david.close)(true),
  ])
  t.end()
})

tape('hops 2', async (t) => {
  const alice = createSsbServer({
    path: path.join(os.tmpdir(), 'server-alice'),
    keys: aliceKeys,
    timeout: CONNECTION_TIMEOUT,
    friends: {
      hops: 2,
    },
  })

  const bob = createSsbServer({
    path: path.join(os.tmpdir(), 'server-bob'),
    keys: bobKeys,
    timeout: CONNECTION_TIMEOUT,
    friends: {
      hops: UNLIMITED,
    },
  })

  const carol = createSsbServer({
    path: path.join(os.tmpdir(), 'server-carol'),
    keys: carolKeys,
    timeout: CONNECTION_TIMEOUT,
    friends: {
      hops: UNLIMITED,
    },
  })

  const david = createSsbServer({
    path: path.join(os.tmpdir(), 'server-david'),
    keys: davidKeys,
    timeout: CONNECTION_TIMEOUT,
    friends: {
      hops: UNLIMITED,
    },
  })

  const [rpcAB, rpcBC, rpcCD] = await Promise.all([
    pify(alice.connect)(bob.getAddress()),
    pify(bob.connect)(carol.getAddress()),
    pify(carol.connect)(david.getAddress()),
  ])

  await sleep(REPLICATION_TIMEOUT)

  // alice => bob => carol -> david
  const clockAlice = await pify(alice.getVectorClock)()
  t.ok(clockAlice[bob.id], 'alice replicates bob')
  t.ok(clockAlice[carol.id], 'alice replicates carol')
  t.notOk(clockAlice[david.id], 'alice does not replicate david')

  await Promise.all([
    pify(rpcAB.close)(true),
    pify(rpcBC.close)(true),
    pify(rpcCD.close)(true),
  ])

  await Promise.all([
    pify(alice.close)(true),
    pify(bob.close)(true),
    pify(carol.close)(true),
    pify(david.close)(true),
  ])
  t.end()
})

tape('hops 2', async (t) => {
  const alice = createSsbServer({
    path: path.join(os.tmpdir(), 'server-alice'),
    keys: aliceKeys,
    timeout: CONNECTION_TIMEOUT,
    friends: {
      hops: 3,
    },
  })

  const bob = createSsbServer({
    path: path.join(os.tmpdir(), 'server-bob'),
    keys: bobKeys,
    timeout: CONNECTION_TIMEOUT,
    friends: {
      hops: UNLIMITED,
    },
  })

  const carol = createSsbServer({
    path: path.join(os.tmpdir(), 'server-carol'),
    keys: carolKeys,
    timeout: CONNECTION_TIMEOUT,
    friends: {
      hops: UNLIMITED,
    },
  })

  const david = createSsbServer({
    path: path.join(os.tmpdir(), 'server-david'),
    keys: davidKeys,
    timeout: CONNECTION_TIMEOUT,
    friends: {
      hops: UNLIMITED,
    },
  })

  const [rpcAB, rpcBC, rpcCD] = await Promise.all([
    pify(alice.connect)(bob.getAddress()),
    pify(bob.connect)(carol.getAddress()),
    pify(carol.connect)(david.getAddress()),
  ])

  await sleep(REPLICATION_TIMEOUT)

  // alice => bob => carol -> david
  const clockAlice = await pify(alice.getVectorClock)()
  t.ok(clockAlice[bob.id], 'alice replicates bob')
  t.ok(clockAlice[carol.id], 'alice replicates carol')
  t.ok(clockAlice[david.id], 'alice replicates david')

  await Promise.all([
    pify(rpcAB.close)(true),
    pify(rpcBC.close)(true),
    pify(rpcCD.close)(true),
  ])

  await Promise.all([
    pify(alice.close)(true),
    pify(bob.close)(true),
    pify(carol.close)(true),
    pify(david.close)(true),
  ])
  t.end()
})
