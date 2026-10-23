/**
 * The challenge's bench/load.js for the tRPC version of the API, for real k6 on a machine with the memory for it
 * (k6 holds a JavaScript runtime per virtual user: thousands of users need many GB). load.mjs is the same scenario
 * for small machines. Same stages, same user loop, same thresholds.
 *
 *   k6 run -e VUS=1000 -e BASE_URL=http://127.0.0.1:3000 -e TOKENS=/path/to/tokens.json load.k6.js
 *
 * User loop: feed.list -> think 3-7 s -> feed.get (one from the feed) -> think 3-8 s -> like it (15%) -> write a post (2%)
 *   -> idle 5-15 s -> repeat. Pass: p95 < 500 ms, p99 < 1000 ms, under 1% failed requests.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';

const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:3000';
const VUS = Number(__ENV.VUS || 100);
const LIKE_PROB = 0.15;
const POST_PROB = 0.02;
const tokens = new SharedArray('tokens', () => JSON.parse(open(__ENV.TOKENS || './tokens.json')));

export const options = {
  scenarios: {
    users: {
      executor: 'ramping-vus',
      stages: [
        { duration: __ENV.RAMP_UP || '60s', target: VUS },
        { duration: __ENV.DURATION || '5m', target: VUS },
        { duration: '30s', target: 0 },
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<500', 'p(99)<1000'],
    http_req_failed: ['rate<0.01'],
  },
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
};

const between = (lo, hi) => lo + Math.random() * (hi - lo);

export default function () {
  const user = tokens[(__VU - 1) % tokens.length];
  // A Better Auth session cookie, in place of the challenge's pre-signed JWT.
  const auth = { headers: { Cookie: user.cookie, 'Content-Type': 'application/json' } };
  if (__ITER === 0) sleep(between(0, 5)); // spread out VUs that start in the same tick

  const feed = http.get(`${BASE_URL}/trpc/feed.list`, { tags: { name: 'feed.list' } });
  if (!check(feed, { 'feed 200': (r) => r.status === 200 })) { sleep(between(3, 7)); return; }
  const posts = feed.json('result.data.posts');
  const post = posts[Math.floor(Math.random() * posts.length)];
  sleep(between(3, 7));

  const get = http.get(`${BASE_URL}/trpc/feed.get?input=${encodeURIComponent(JSON.stringify({ id: post.id }))}`, { tags: { name: 'feed.get' } });
  check(get, { 'post 200': (r) => r.status === 200 });
  sleep(between(3, 8));

  if (Math.random() < LIKE_PROB) {
    const r = http.post(`${BASE_URL}/trpc/feed.like`, JSON.stringify({ postId: post.id }), { ...auth, tags: { name: 'feed.like' } });
    check(r, { 'like 200': (r) => r.status === 200 });
  }
  if (Math.random() < POST_PROB) {
    const body = JSON.stringify({ body: `${user.username} says hi at ${new Date().toISOString()} (VU ${__VU}, iter ${__ITER})` });
    check(http.post(`${BASE_URL}/trpc/feed.create`, body, { ...auth, tags: { name: 'feed.create' } }), { 'create 200': (r) => r.status === 200 });
  }
  sleep(between(5, 15));
}
