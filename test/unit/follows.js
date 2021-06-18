const tape = require('tape')
const pull = require('pull-stream')
const ssbKeys = require('ssb-keys')
const Server = require('scuttle-testbot')

tape('listen to friends stream and replicates initial follows', (t) => {
  t.plan(6)
  const bobId = ssbKeys.generate().id

  Server
    .use({
      name: 'friends',
      init(sbot) {
        return {
          graphStream() {
            return pull.values([{source: sbot.id, dest: bobId, value: 1}])
          },
        }
      },
    })
    .use({
      name: 'ebt',
      init(sbot) {
        return {
          request(feed, bool) {
            if (feed === sbot.id) return
            t.equals(feed, bobId, 'requested feed id matches')
            t.true(bool, 'bool is true')
            setTimeout(() => {
              sbot.close((err) => {
                t.error(err, 'close sbot')
                t.end()
              })
            }, 50)
          },
          block(orig, dest, bool) {
            t.equals(orig, sbot.id, 'block orig is myself')
            t.equals(dest, bobId, 'block dest is bob')
            t.false(bool, 'block flag is false')
          },
        }
      },
    })
    .use(require('../..'))
    .call(null, {})
})

tape('listen to friends stream and replicates subsequent follows', (t) => {
  t.plan(6)
  const bobId = ssbKeys.generate().id

  Server
    .use({
      name: 'friends',
      init(sbot) {
        return {
          graphStream() {
            return pull.values([
              {
                [sbot.id]: {
                  [bobId]: 1,
                },
              },
            ])
          },
        }
      },
    })
    .use({
      name: 'ebt',
      init(sbot) {
        return {
          request(feed, bool) {
            if (feed === sbot.id) return
            t.equals(feed, bobId, 'requested feed id matches')
            t.true(bool, 'bool is true')
            sbot.close((err) => {
              t.error(err, 'close sbot')
              t.end()
            })
          },
          block(orig, dest, bool) {
            t.equals(orig, sbot.id, 'block orig is myself')
            t.equals(dest, bobId, 'block dest is bob')
            t.false(bool, 'block flag is false')
          },
        }
      },
    })
    .use(require('../..'))
    .call(null, {})
})
