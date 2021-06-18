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

  const [connectionBA, connectionBC, connectionCA] = await Promise.all([
    pify(bob.connect)(alice.getAddress()),
    pify(bob.connect)(carol.getAddress()),
    // pify(carol.connect)(alice.getAddress()),
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

/**
 * The difference between this test and the previous, is that here we do a
 * restart of the 3 peers after they publish messages. We want to test whether
 * ssb-replication-scheduler can load the *existing* social graph as soon as it
 * is initialized, so the 3 peers need to have published messages in their
 * databases *before* they start up.
 */
tape('replicate between 3 peers, using ssb-db2, restarting', async (t) => {
  rimraf.sync(path.join(os.tmpdir(), 'server-alice'))
  rimraf.sync(path.join(os.tmpdir(), 'server-bob'))
  rimraf.sync(path.join(os.tmpdir(), 'server-carol'))

  const aliceKeys = ssbKeys.generate()
  const bobKeys = ssbKeys.generate()
  const carolKeys = ssbKeys.generate()

  let alice = createSsbServer({
    path: path.join(os.tmpdir(), 'server-alice'),
    keys: aliceKeys,
    timeout: CONNECTION_TIMEOUT,
  })
  let bob = createSsbServer({
    path: path.join(os.tmpdir(), 'server-bob'),
    keys: bobKeys,
    timeout: CONNECTION_TIMEOUT,
  })
  let carol = createSsbServer({
    path: path.join(os.tmpdir(), 'server-carol'),
    keys: carolKeys,
    timeout: CONNECTION_TIMEOUT,
  })

  // Wait for all bots to be ready
  await sleep(200)

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

  await Promise.all([
    pify(alice.close)(true),
    pify(bob.close)(true),
    pify(carol.close)(true)
  ])
  t.pass('closed the 3 peers')

  alice = createSsbServer({
    path: path.join(os.tmpdir(), 'server-alice'),
    keys: aliceKeys,
    timeout: CONNECTION_TIMEOUT,
  })
  bob = createSsbServer({
    path: path.join(os.tmpdir(), 'server-bob'),
    keys: bobKeys,
    timeout: CONNECTION_TIMEOUT,
  })
  carol = createSsbServer({
    path: path.join(os.tmpdir(), 'server-carol'),
    keys: carolKeys,
    timeout: CONNECTION_TIMEOUT,
  })
  t.pass('restarted the 3 peers')

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