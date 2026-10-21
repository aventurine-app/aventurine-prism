'use strict';

// One editing tab at a time, with a fake of the browser's Web Locks.

const test = require('node:test');
const assert = require('node:assert/strict');

const { claimEditor } = require('../../static/js/web/session.js');

/** Just enough of LockManager: one lock name, ifAvailable, and a queue. */
function fakeLocks() {
    let held = false;
    const queue = [];
    return {
        request(_name, optionsOrCallback, maybeCallback) {
            const [options, callback] = typeof optionsOrCallback === 'function'
                ? [{}, optionsOrCallback]
                : [optionsOrCallback, maybeCallback];
            if (!held) {
                held = true;
                return Promise.resolve(callback({}));
            }
            if (options.ifAvailable) return Promise.resolve(callback(null));
            return new Promise(() => queue.push(callback));
        },
        /** The tab holding the lock closes. */
        release() {
            held = false;
            const next = queue.shift();
            if (next) {
                held = true;
                next({});
            }
        },
    };
}

const settled = (promise) => Promise.race([promise.then(() => true), new Promise((r) => setImmediate(() => r(false)))]);

test('the first tab owns editing at once', async () => {
    const claim = await claimEditor(fakeLocks());
    assert.equal(claim.owned, true);
    assert.equal(await settled(claim.acquired), true);
});

test('a second tab waits, then takes over when the first closes', async () => {
    const locks = fakeLocks();
    await claimEditor(locks);

    const second = await claimEditor(locks);
    assert.equal(second.owned, false);
    assert.equal(await settled(second.acquired), false, 'it is still waiting');

    locks.release();
    assert.equal(await settled(second.acquired), true);
});

test('a third tab queues behind the second', async () => {
    const locks = fakeLocks();
    await claimEditor(locks);
    const second = await claimEditor(locks);
    const third = await claimEditor(locks);

    locks.release();
    assert.equal(await settled(second.acquired), true);
    assert.equal(await settled(third.acquired), false);
    locks.release();
    assert.equal(await settled(third.acquired), true);
});

test('a browser without Web Locks edits without the guard', async () => {
    const claim = await claimEditor(undefined);
    assert.equal(claim.owned, true);
    assert.equal(await settled(claim.acquired), true);
});
