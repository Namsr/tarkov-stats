# Tarkov Stats

Tarkov Stats is an open-source web app for exploring public Escape from Tarkov
player statistics. Search for a player, compare profiles, and follow changes in
historical statistics.

## Development

Requires Node.js 22 or newer.

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

Useful checks before opening a pull request:

```bash
npm run i18n:check
npm run lint
npm test
npm run build
```

Most local development works without additional configuration. If a local
integration needs environment variables, copy `.env.example` to `.env` and use
local values only. Never commit `.env` files, credentials, databases, backups,
or deployment configuration.

## Contributing

Bug reports, small fixes, tests, and focused improvements are welcome. Please
open an issue for a larger change before starting implementation, then submit a
pull request with a short description and the checks you ran.

## Project structure

- `app/` — pages and API routes
- `components/` — reusable UI components
- `lib/` — application logic and data access
- `tests/` — automated tests

The application reads public Tarkov data from JSON endpoints and is not
affiliated with Battlestate Games or Tarkov.dev.
