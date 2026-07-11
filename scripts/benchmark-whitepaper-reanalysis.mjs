#!/usr/bin/env node

/**
 * benchmark-whitepaper.md 的确定性复算脚本。
 *
 * 只读取已经归档的逐题结果，不重新调用任何模型：
 * 1. 研究三 14 臂的全集准确率（无效/弃答/平票计错）与 coverage；
 * 2. 研究二 N=200 勘误后的正确数；
 * 3. 研究二按命主聚类的配对 bootstrap CI 与符号翻转检验。
 *
 * 用法：node scripts/benchmark-whitepaper-reanalysis.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const YEARS = [2021, 2022, 2023, 2024, 2025];
const TRACKS = ['ds', 'gm', 'op'];
const B = 100_000;

const readJson = (file) => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
const pct = (x) => `${(100 * x).toFixed(1)}%`;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function study3Answer(track, row) {
  if (track !== 'ds') return row.votes?.[0] ?? null;
  const tally = {};
  for (const vote of row.votes || []) if (vote) tally[vote] = (tally[vote] || 0) + 1;
  const ranked = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  return ranked.length && ranked[0][1] >= 2 ? ranked[0][0] : null;
}

function study3Metrics(K, track) {
  let correct = 0;
  let answered = 0;
  let total = 0;
  for (const year of YEARS) {
    const run = readJson(`study3-results/${track}-${K}-${year}.json`);
    for (const row of run.results) {
      total++;
      const answer = study3Answer(track, row);
      if (!answer) continue;
      answered++;
      if (answer === row.gold) correct++;
    }
  }
  return { correct, answered, total, full: correct / total, coverage: answered / total };
}

function study3ByPerson(K, track) {
  const byPerson = new Map();
  for (const year of YEARS) {
    const run = readJson(`study3-results/${track}-${K}-${year}.json`);
    for (const row of run.results) {
      const key = `${year}|${row.person}`;
      const hits = byPerson.get(key) || [];
      const answer = study3Answer(track, row);
      hits.push(answer && answer === row.gold ? 1 : 0);
      byPerson.set(key, hits);
    }
  }
  return byPerson;
}

function study3ClusterSummary(aK, bK, seed = 20260713) {
  const aMaps = Object.fromEntries(TRACKS.map((track) => [track, study3ByPerson(aK, track)]));
  const bMaps = Object.fromEntries(TRACKS.map((track) => [track, study3ByPerson(bK, track)]));
  const persons = [...aMaps.ds.keys()];
  const rng = mulberry32(seed);
  const aBoot = [];
  const bBoot = [];
  const dBoot = [];

  for (let i = 0; i < B; i++) {
    const sampled = Array.from({ length: persons.length }, () => persons[Math.floor(rng() * persons.length)]);
    const scores = (maps) => TRACKS.map((track) => {
      let correct = 0;
      let total = 0;
      for (const person of sampled) {
        const hits = maps[track].get(person);
        if (!hits) throw new Error(`missing ${track} cluster: ${person}`);
        correct += hits.reduce((sum, hit) => sum + hit, 0);
        total += hits.length;
      }
      return correct / total;
    }).reduce((sum, score) => sum + score, 0) / TRACKS.length;
    const a = scores(aMaps);
    const b = scores(bMaps);
    aBoot.push(a);
    bBoot.push(b);
    dBoot.push(a - b);
  }

  const interval = (values) => {
    values.sort((x, y) => x - y);
    return [values[Math.floor(values.length * 0.025)], values[Math.floor(values.length * 0.975)]];
  };
  const observed = (maps) => TRACKS.map((track) => {
    const hits = [...maps[track].values()].flat();
    return hits.reduce((sum, hit) => sum + hit, 0) / hits.length;
  }).reduce((sum, score) => sum + score, 0) / TRACKS.length;
  const a = observed(aMaps);
  const b = observed(bMaps);
  return { a, b, difference: a - b, aCi95: interval(aBoot), bCi95: interval(bBoot), differenceCi95: interval(dBoot), clusters: persons.length };
}

function printStudy3() {
  const master = readJson('study3-results/UNBLINDED-MASTER.json');
  const rows = master.rows.map(({ arm, K }) => {
    const tracks = Object.fromEntries(TRACKS.map((track) => [track, study3Metrics(K, track)]));
    const mean = TRACKS.reduce((sum, track) => sum + tracks[track].full, 0) / TRACKS.length;
    return { arm, K, tracks, mean };
  }).sort((a, b) => b.mean - a.mean);

  console.log('# 研究三：全集准确率\n');
  console.log('| 实验臂 | DeepSeek | Gemini | Opus | 三模型描述均值 | coverage 范围 |');
  console.log('|---|---:|---:|---:|---:|---:|');
  for (const row of rows) {
    const coverages = TRACKS.map((track) => row.tracks[track].coverage);
    console.log(`| ${row.arm} | ${pct(row.tracks.ds.full)} | ${pct(row.tracks.gm.full)} | ${pct(row.tracks.op.full)} | ${pct(row.mean)} | ${pct(Math.min(...coverages))}–${pct(Math.max(...coverages))} |`);
  }
  console.log();
  const comparison = study3ClusterSummary('K13', 'K9');
  console.log(`chart: ${pct(comparison.a)}; 95% cluster bootstrap CI [${pct(comparison.aCi95[0])}, ${pct(comparison.aCi95[1])}]`);
  console.log(`tieban-v2: ${pct(comparison.b)}; 95% cluster bootstrap CI [${pct(comparison.bCi95[0])}, ${pct(comparison.bCi95[1])}]`);
  console.log(`chart - tieban-v2: ${pct(comparison.difference)}; paired 95% cluster bootstrap CI [${pct(comparison.differenceCi95[0])}, ${pct(comparison.differenceCi95[1])}]; clusters=${comparison.clusters}\n`);
}

function study2ByPerson(arm) {
  const byPerson = new Map();
  for (const year of YEARS) {
    const run = readJson(`mc-${arm}-${year}.json`);
    for (const row of run.results) {
      const key = `${year}|${row.person}`;
      const hits = byPerson.get(key) || [];
      for (let i = 0; i < row.gold.length; i++) hits.push(row.answers[i] === row.gold[i] ? 1 : 0);
      byPerson.set(key, hits);
    }
  }
  return byPerson;
}

function pairedCluster(a, b, seed = 20260711) {
  const A = study2ByPerson(a);
  const Bmap = study2ByPerson(b);
  const clusters = [];
  for (const [person, aHits] of A) {
    const bHits = Bmap.get(person);
    if (!bHits || bHits.length !== aHits.length) throw new Error(`unpaired cluster: ${person}`);
    clusters.push({
      n: aHits.length,
      sum: aHits.reduce((total, hit, i) => total + hit - bHits[i], 0),
    });
  }

  const totalN = clusters.reduce((total, cluster) => total + cluster.n, 0);
  const observedCount = clusters.reduce((total, cluster) => total + cluster.sum, 0);
  const observed = observedCount / totalN;

  const permRng = mulberry32(seed);
  let atLeastAsExtreme = 0;
  for (let i = 0; i < B; i++) {
    let sampled = 0;
    for (const cluster of clusters) sampled += (permRng() < 0.5 ? -1 : 1) * cluster.sum;
    if (Math.abs(sampled) >= Math.abs(observedCount)) atLeastAsExtreme++;
  }

  const bootRng = mulberry32(seed + 1);
  const boot = [];
  for (let i = 0; i < B; i++) {
    let sampledCount = 0;
    let sampledN = 0;
    for (let j = 0; j < clusters.length; j++) {
      const cluster = clusters[Math.floor(bootRng() * clusters.length)];
      sampledCount += cluster.sum;
      sampledN += cluster.n;
    }
    boot.push(sampledCount / sampledN);
  }
  boot.sort((x, y) => x - y);
  const quantile = (p) => boot[Math.floor(p * boot.length)];

  return {
    n: totalN,
    clusters: clusters.length,
    difference: observed,
    ci95: [quantile(0.025), quantile(0.975)],
    pTwoSided: (atLeastAsExtreme + 1) / (B + 1),
  };
}

function study2Total(arm) {
  const byPerson = study2ByPerson(arm);
  const total = [...byPerson.values()].reduce((sum, hits) => sum + hits.length, 0);
  const correct = [...byPerson.values()].reduce((sum, hits) => sum + hits.reduce((a, b) => a + b, 0), 0);
  return { correct, total, accuracy: correct / total };
}

function printStudy2() {
  console.log('# 研究二：N=200 勘误与命主级配对重分析\n');
  for (const arm of ['chart', 'bare', 'bayes']) {
    const result = study2Total(arm);
    console.log(`${arm}: ${result.correct}/${result.total} = ${pct(result.accuracy)}`);
  }
  for (const [a, b] of [['chart', 'bare'], ['chart', 'bayes']]) {
    const result = pairedCluster(a, b);
    console.log(`${a} - ${b}: ${pct(result.difference)}; 95% cluster bootstrap CI [${pct(result.ci95[0])}, ${pct(result.ci95[1])}]; paired cluster sign-flip p=${result.pTwoSided.toFixed(4)}; n=${result.n}, clusters=${result.clusters}`);
  }
}

printStudy3();
printStudy2();
