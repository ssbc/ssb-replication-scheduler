// SPDX-FileCopyrightText: 2021 Andre 'Staltz' Medeiros
//
// SPDX-License-Identifier: Unlicense

const test = require('tape')
const crypto = require('crypto')
const fs = require('fs')
const ssbKeys = require('ssb-keys')
const pify = require('promisify-4loc')
const path = require('path')
const rimraf = require('rimraf')
const mkdirp = require('mkdirp')
const generateFixture = require('ssb-fixtures')
const sleep = require('util').promisify(setTimeout)
const SecretStack = require('secret-stack')

const createSbot = SecretStack({
  caps: { shs: crypto.randomBytes(32).toString('base64') },
})
  .use(require('ssb-db'))
  .use(require('ssb-friends'))
  .use(require('ssb-ebt'))
  .use(require('../..'))

// Alice and Bob need separate folders because of flume DB IO locks
const ALICE_DIR = '/tmp/ssb-replication-scheduler-fixtures-alice'
const BOB_DIR = '/tmp/ssb-replication-scheduler-fixtures-bob'

const CONNECTION_TIMEOUT = 500 // ms
const REPLICATION_TIMEOUT = 6 * CONNECTION_TIMEOUT

test('generate fixture with flumelog-offset', async (t) => {
  rimraf.sync(ALICE_DIR, { maxBusyTries: 3 })
  mkdirp.sync(ALICE_DIR)

  rimraf.sync(BOB_DIR, { maxBusyTries: 3 })
  mkdirp.sync(BOB_DIR)

  await generateFixture({
    outputDir: ALICE_DIR,
    seed: 'ssbreplicationscheduler',
    messages: 5000,
    authors: 100,
    slim: false,
  })

  t.true(
    fs.existsSync(path.join(ALICE_DIR, 'flume', 'log.offset')),
    "alice's log.offset was created"
  )
  t.end()
})

test('tests large-scale EBT replication', async (t) => {
  const aliceKeys = ssbKeys.loadOrCreateSync(path.join(ALICE_DIR, 'secret'))
  t.ok(aliceKeys, "alice's keys exist in the fixture")

  const bobKeys = ssbKeys.loadOrCreateSync(path.join(ALICE_DIR, 'secret-1'))
  t.ok(bobKeys, "bob's keys exist in the fixture")

  const alice = createSbot({
    path: ALICE_DIR,
    timeout: CONNECTION_TIMEOUT,
    keys: aliceKeys,
    friends: { hops: 2 },
  })

  const bob = createSbot({
    path: BOB_DIR,
    timeout: CONNECTION_TIMEOUT,
    keys: bobKeys,
    friends: { hops: 2 },
  })

  t.ok(alice.getAddress(), 'alice has an address')

  await pify(alice.publish)({
    type: 'contact',
    contact: bob.id,
    following: true,
  })
  t.pass('make sure that alice follows bob')

  const bobPuppet = alice.createFeed(bobKeys)
  await pify(bobPuppet.publish)({
    type: 'contact',
    contact: alice.id,
    following: true,
  })
  t.pass('make sure that bob follows alice')

  await pify(bob.connect)(alice.getAddress())
  t.pass('bob is connected to alice')

  await sleep(REPLICATION_TIMEOUT)

  const clockAlice = await pify(alice.getVectorClock)()
  const clockBob = await pify(bob.getVectorClock)()

  t.equals(
    clockBob[alice.id],
    clockAlice[alice.id],
    "bob has all of alice's data"
  )

  const prog = alice.progress()
  t.ok(prog.indexes, 'alice indexes are okay')
  t.ok(prog.ebt, 'alice ebt is okay')
  t.ok(prog.ebt.target, 'alice ebt.target is okay')
  t.strictEqual(prog.ebt.current, prog.ebt.target, 'alice ebt finished')

  await Promise.all([pify(alice.close)(true), pify(bob.close)(true)])
  t.end()
})
