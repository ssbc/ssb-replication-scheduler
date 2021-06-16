const tape = require('tape')
const crypto = require('crypto')
const ssbKeys = require('ssb-keys')
const path = require('path')
const os = require('os')
const rimraf = require('rimraf')
const SecretStack = require('secret-stack')
const pify = require('promisify-4loc')
const sleep = require('util').promisify(setTimeout)

const createSsbServer = SecretStack({
  caps: { shs: crypto.randomBytes(32).toString('base64') }
})
  .use(require('ssb-db2'))
  .use(require('ssb-db2/compat/ebt'))
  .use(require('ssb-ebt'))
  .use(require('ssb-friends'))
  .use(require('../..'))

const CONNECTION_TIMEOUT = 500 // ms
const REPLICATION_TIMEOUT = 4 * CONNECTION_TIMEOUT

tape('replicate between 3 peers, using ssb-db2', async (t) => {
  rimraf.sync(path.join(os.tmpdir(), 'server-alice'))
  rimraf.sync(path.join(os.tmpdir(), 'server-bob'))
  rimraf.sync(path.join(os.tmpdir(), 'server-carol'))

  const alice = createSsbServer({
    path: path.join(os.tmpdir(), 'server-alice'),
    keys: ssbKeys.generate(),
    timeout: CONNECTION_TIMEOUT,
  })
  const bob = createSsbServer({
    path: path.join(os.tmpdir(), 'server-bob'),
    keys: ssbKeys.generate(),
    timeout: CONNECTION_TIMEOUT,
  })
  const carol = createSsbServer({
    path: path.join(os.tmpdir(), 'server-carol'),
    keys: ssbKeys.generate(),
    timeout: CONNECTION_TIMEOUT,
  })
  t.pass('started the 3 peers')

  // Wait for all bots to be ready
  await sleep(500)

  await Promise.all([
    // All peers publish a post
    pify(alice.db.publish)({ type: 'post', text: 'hello' }),
    pify(bob.db.publish)({ type: 'post', text: 'hello' }),
    pify(carol.db.publish)({ type: 'post', text: 'hello' }),

    // alice follows bob & carol
    pify(alice.db.publish)({ type: 'contact', contact: bob.id, following: true }),
    pify(alice.db.publish)({ type: 'contact', contact: carol.id, following: true }),

    // bob follows alice & carol
    pify(bob.db.publish)({ type: 'contact', contact: alice.id, following: true }),
    pify(bob.db.publish)({ type: 'contact', contact: carol.id, following: true }),

    // carol follows alice & bob
    pify(carol.db.publish)({ type: 'contact', contact: alice.id, following: true }),
    pify(carol.db.publish)({ type: 'contact', contact: bob.id, following: true }),
  ])
  t.pass('published all the messages')

  // This is unfortunately needed, otherwise *sometimes* we get errors such
  // [NotFoundError]: Key not found in database [["<FEEDID>",1]]
  await Promise.all([
    pify(alice.db.onDrain)('ebt'),
    pify(bob.db.onDrain)('ebt'),
    pify(carol.db.onDrain)('ebt'),
  ])

  const [connectionBA, connectionBC, connectionCA] = await Promise.all([
    pify(bob.connect)(alice.getAddress()),
    pify(bob.connect)(carol.getAddress()),
    pify(carol.connect)(alice.getAddress()),
  ])
  t.pass('peers are connected to each other')

  const expectedClock = {
    [alice.id]: 3,
    [bob.id]: 3,
    [carol.id]: 3,
  }

  await sleep(REPLICATION_TIMEOUT)
  t.pass('replication period is over')

  const [clockAlice, clockBob, clockCarol] = await Promise.all([
    pify(alice.getVectorClock)(),
    pify(bob.getVectorClock)(),
    pify(carol.getVectorClock)(),
  ])
  t.pass('getVectorClocks')

  t.deepEqual(clockAlice, expectedClock, 'alice\'s clock is correct')
  t.deepEqual(clockBob, expectedClock, 'bob\'s clock is correct')
  t.deepEqual(clockCarol, expectedClock, 'carol\'s clock is correct')

  await Promise.all([
    pify(connectionBA.close)(true),
    pify(connectionBC.close)(true),
    pify(connectionCA.close)(true),
  ])

  await Promise.all([
    pify(alice.close)(true),
    pify(bob.close)(true),
    pify(carol.close)(true)
  ])

  t.end()
})
