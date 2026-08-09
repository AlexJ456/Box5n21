import test from 'node:test';
import assert from 'node:assert/strict';
import {
    SessionEngine,
    buildPhases,
    getTargetTiming,
    locatePhase,
    sanitiseRoutine
} from '../session-engine.js';

const box = {
    exerciseId: 'box',
    phaseTime: 4,
    exhaleDuration: 6,
    targetType: 'open',
    targetValue: 0
};

test('preserves every built-in breathing pattern', () => {
    assert.deepEqual(buildPhases(box), [
        { name: 'Inhale', duration: 4 },
        { name: 'Hold', duration: 4 },
        { name: 'Exhale', duration: 4 },
        { name: 'Wait', duration: 4 }
    ]);
    assert.deepEqual(buildPhases({ ...box, exerciseId: 'fourSevenEight' }), [
        { name: 'Inhale', duration: 4 },
        { name: 'Hold', duration: 7 },
        { name: 'Exhale', duration: 8 }
    ]);
    assert.deepEqual(buildPhases({ ...box, exerciseId: 'longExhale', exhaleDuration: 8 }), [
        { name: 'Inhale', duration: 4 },
        { name: 'Exhale', duration: 8 }
    ]);
    assert.deepEqual(buildPhases({ ...box, exerciseId: 'coherent', phaseTime: 4.5 }), [
        { name: 'Inhale', duration: 4.5 },
        { name: 'Exhale', duration: 4.5 }
    ]);
});

test('snaps adjustable values and target limits to safe ranges', () => {
    assert.equal(sanitiseRoutine({ ...box, phaseTime: 99 }).phaseTime, 6);
    assert.equal(sanitiseRoutine({ ...box, exerciseId: 'coherent', phaseTime: 5.3 }).phaseTime, 5.5);
    assert.equal(sanitiseRoutine({ ...box, exerciseId: 'longExhale', exhaleDuration: 2 }).exhaleDuration, 6);
    assert.equal(sanitiseRoutine({ ...box, targetType: 'minutes', targetValue: 200 }).targetValue, 120);
});

test('locates phases and completed rounds at exact boundaries', () => {
    assert.equal(locatePhase(box, 0).phase.name, 'Inhale');
    assert.equal(locatePhase(box, 4_000).phase.name, 'Hold');
    assert.equal(locatePhase(box, 8_000).phase.name, 'Exhale');
    assert.equal(locatePhase(box, 12_000).phase.name, 'Wait');
    assert.equal(locatePhase(box, 16_000).phase.name, 'Inhale');
    assert.equal(locatePhase(box, 16_000).completedRounds, 1);
});

test('time limits finish at the appropriate exhale boundary', () => {
    assert.deepEqual(getTargetTiming({ ...box, targetType: 'minutes', targetValue: 2 }), {
        targetAtMs: 120_000,
        naturalEndMs: 124_000
    });
    assert.deepEqual(getTargetTiming({ ...box, targetType: 'minutes', targetValue: 5 }), {
        targetAtMs: 300_000,
        naturalEndMs: 300_000
    });
    assert.deepEqual(getTargetTiming({ ...box, targetType: 'minutes', targetValue: 10 }), {
        targetAtMs: 600_000,
        naturalEndMs: 604_000
    });
    assert.deepEqual(getTargetTiming({ ...box, exerciseId: 'longExhale', targetType: 'minutes', targetValue: 2 }), {
        targetAtMs: 120_000,
        naturalEndMs: 120_000
    });
});

test('round targets end exactly after the final 4-7-8 exhale', () => {
    assert.deepEqual(getTargetTiming({
        ...box,
        exerciseId: 'fourSevenEight',
        targetType: 'rounds',
        targetValue: 4
    }), {
        targetAtMs: 76_000,
        naturalEndMs: 76_000
    });
});

test('pause and resume preserve exact elapsed time', () => {
    let now = 0;
    let nextFrame = null;
    const frames = [];
    const statuses = [];
    const engine = new SessionEngine({
        onTick: (frame) => frames.push(frame),
        onStatusChange: (status) => statuses.push(status)
    }, {
        now: () => now,
        requestFrame: (callback) => {
            nextFrame = callback;
            return 1;
        },
        cancelFrame: () => {
            nextFrame = null;
        }
    });

    engine.start(box);
    now = 2_500;
    nextFrame(now);
    engine.pause();
    assert.equal(Math.round(engine.elapsedMs), 2_500);

    now = 20_000;
    assert.equal(Math.round(engine.elapsedMs), 2_500);
    engine.resume();
    now = 21_500;
    nextFrame(now);
    assert.equal(Math.round(engine.elapsedMs), 4_000);
    assert.equal(frames.at(-1).phase.name, 'Hold');
    assert.deepEqual(statuses.slice(0, 3), ['running', 'paused', 'running']);
});

test('a target completion is emitted once at its natural end', () => {
    let now = 0;
    let nextFrame = null;
    const completions = [];
    const engine = new SessionEngine({
        onComplete: (result) => completions.push(result)
    }, {
        now: () => now,
        requestFrame: (callback) => {
            nextFrame = callback;
            return 1;
        },
        cancelFrame: () => {
            nextFrame = null;
        }
    });

    engine.start({
        ...box,
        exerciseId: 'fourSevenEight',
        targetType: 'rounds',
        targetValue: 4
    });
    now = 76_500;
    nextFrame(now);

    assert.equal(engine.status, 'complete');
    assert.equal(completions.length, 1);
    assert.equal(completions[0].elapsedMs, 76_000);
    assert.equal(completions[0].reason, 'target');
});
