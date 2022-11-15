const test = require('tape')
const rimraf = require('rimraf')
const SecretStack = require('secret-stack')
const caps = require('ssb-caps')
const ssbKeys = require('ssb-keys')
const p = require('promisify-4loc')
const u = require('../misc/util')

const Server = (name, opts = {}) => {
  const path = `/tmp/ssb-replication-tests-${name}`
  rimraf.sync(path)

  return SecretStack({ caps })
    .use(require('ssb-db2'))
    .use(require('ssb-db2/compat/ebt'))
    .use(require('ssb-bendy-butt'))
    .use(require('ssb-conn'))
    .use(require('ssb-ebt'))
    .use(require('ssb-friends'))
    .use(require('ssb-tribes2'))
    .use(require('ssb-meta-feeds'))
    .use(require('ssb-subset-rpc'))
    .use(require('ssb-index-feeds'))
    .use(require('../..'))({
    path,
    keys: ssbKeys.generate(),
    ...opts,
  })
}

test.only('You replicate other people in a group', async (t) => {
  const alice = Server('alice', {
    friends: {
      hops: 1,
    },
  })

  const bob = Server('bob', {
    friends: {
      hops: 1,
    },
    replicationScheduler: {
      debouncePeriod: 1,
      partialReplication: {
        1: [{ purpose: 'main' }],
        group: [{ purpose: '$groupSecret' }],
      },
    },
  })

  const carol = Server('carol', {
    friends: {
      hops: 1,
    },
  })

  await Promise.all([
    p(alice.db.publish)(u.follow(bob.id)),
    p(alice.db.publish)(u.follow(carol.id)),
    p(bob.db.publish)(u.follow(alice.id)),
    p(carol.db.publish)(u.follow(alice.id)),
  ])

  console.log('group creating')
  const group = await alice.tribes2.create()

  console.log('group created')
  await alice.tribes2.addMembers(group.id, [bob.id, carol.id])
  console.log('added members')
  console.log('alice is', alice.id)

  // todo replicate

  const carolHi = await carol.tribes2.publish({ text: 'hi', recps: [group.id] })

  console.log('carol published')
  // todo connect bob and carol

  bob.db.get(carolHi.key)

  console.log('msg gotten')
  //TODO: test something
})
