# Contributing

Thanks for contributing to Job Decision Engine.

## Development Setup

1. Install Node.js 22+.
2. Install dependencies:

```bash
npm ci
```

3. Create `.env.local` from [.env.example](.env.example) and fill in required values.
4. Run migrations:

```bash
npm run db:init
```

## Validation Before PR

Run all required checks locally:

```bash
npm run lint
npm test
```

## Pull Request Expectations

1. Keep changes additive and scoped.
2. Include or update tests with behavior changes.
3. Do not commit secrets or personal profile data.
4. For migration changes, verify both clean-install and upgrade-path behavior.
5. Update docs when behavior, env vars, or workflows change.

## Safety Rules

1. Do not weaken data integrity constraints to satisfy tests.
2. Infrastructure and provider failures must not become career rejections.
3. Unknown workability facts must remain `NEEDS_VERIFICATION`.
