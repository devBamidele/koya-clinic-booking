# Clinic booking API

An API that lets patients book clinic appointment slots, plus a web page that uses it.
Built with Node.js, Express and Postgres. It follows the
[assessment spec](https://koyaacademy.com/assessment-api) for all five levels.

- **API base URL:** `https://<host>/api`
- **Web page:** `https://<host>/`

Every API request needs the `X-API-Key` header. Errors are always `{"error": "<message>"}`.

## Endpoints

| Method | Path | Level | What it does |
| --- | --- | --- | --- |
| POST | `/api/reset` | 1 | Deletes every booking and replaces all slots |
| GET | `/api/slots?provider=` | 1 | Lists slots, earliest first, with `available` |
| POST | `/api/bookings` | 1–5 | Books a slot |
| GET | `/api/bookings/{id}` | 1 | Gets one booking |
| DELETE | `/api/bookings/{id}` | 3 | Cancels a booking and frees the slot |
| GET | `/api/bookings?email=&limit=&cursor=` | 4 | A person's bookings, oldest first, paged |

## How each level is handled

**Level 1.** Slots and bookings live in Postgres, so they survive restarts. Slot `start` and
`end` are returned exactly as they were sent. A parsed copy is kept for sorting and time checks.

**Level 2.** A middleware rejects any `/api` request without the right key with 401. It
compares hashes in constant time. Bookings are validated in this order: missing or empty
fields, then a bad email, then 404 for an unknown slot, then 400 if the slot has started.
Name and email are trimmed and the email is stored in lower case.

**Level 3.** Each booking runs in a transaction that locks the slot's row with
`SELECT ... FOR UPDATE`. Simultaneous requests for one slot queue up, and only the first
one finds it free. A partial unique index allows only one `confirmed` booking per slot,
so the database enforces the rule even if the code had a bug. Cancelling sets
`status = 'cancelled'`, which frees the slot. Cancelling twice returns 409.

**Level 4.** An `Idempotency-Key` is claimed by inserting it into a table inside the booking
transaction. A second request with the same key waits for the first to commit, then replays
the stored status code and body. A different body under the same key returns 422. Paging
uses an opaque cursor that encodes the position of the last booking returned.

**Level 5.** Each attempt is recorded per email, failed ones included. A Postgres advisory
lock per email makes the count exact under concurrency. The 6th attempt in 60 seconds gets
429 with `Retry-After` set to the seconds until the oldest attempt leaves the window.
Replayed idempotent requests and rejected 429 requests are not counted.

`POST /api/reset` also clears idempotency keys and rate-limit counters, so each test run
starts clean.

## Run locally

```bash
npm install
cp .env.example .env   # then fill in DATABASE_URL and API_KEY
export $(cat .env | xargs) && npm start
```

The tests start a throwaway Postgres automatically, so you don't need one installed:

```bash
npm test
```

## Deploy (Render + Neon, both free)

1. Create a Postgres database on [Neon](https://neon.tech) and copy its connection string.
2. On [Render](https://render.com), choose **New > Blueprint** and pick this repo.
   It reads `render.yaml`.
3. Paste the Neon string into `DATABASE_URL`. Render generates `API_KEY` for you.
4. The schema is created on first start, and a week of demo slots is added if the
   database is empty. Set `SEED_DEMO_SLOTS=false` to skip that.

## A note on the web page and the key

The page needs the API key to call the API, so the server writes it into the page it
serves. Anyone who opens the page can read it. That's fine for this exercise. A real clinic
would give the browser its own login or session instead of the server's key.
