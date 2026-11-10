# @enterprise-sync/shared

Shared TypeScript library used by `api-gateway` and `integration-worker`.

## Exports

| Export | Description |
| --- | --- |
| `AppLogger` | NestJS `ConsoleLogger` subclass that prefixes every message with the current correlation ID from `nestjs-cls`. |

## AppLogger

`AppLogger` reads `correlationId` from the injected `ClsService` and prefixes string and object messages:

```text
[Correlation-ID: 123e4567-e89b-12d3-a456-426614174000] Job completed successfully
```

The `ClsService` and context arguments are optional, so the logger can also be constructed without a request/CLS scope (for example in interceptors or unit tests):

```ts
import { AppLogger } from '@enterprise-sync/shared';

const logger = new AppLogger();
logger.log('No correlation ID available');
```

Typical Nest usage:

```ts
import { AppLogger } from '@enterprise-sync/shared';

@Injectable()
export class MyService {
  constructor(private readonly logger: AppLogger) {
    this.logger.log('Service started');
  }
}
```

In both services `AppLogger` is registered as a Nest provider, so injection picks up the active `ClsService` automatically. When no correlation ID is present in the CLS context, messages are logged unchanged.

## Build

```bash
pnpm --filter "@enterprise-sync/shared" build
```

Watch mode:

```bash
pnpm --filter "@enterprise-sync/shared" start:dev
```

The package compiles to `dist/` (`main` = `dist/index.js`, `types` = `dist/index.d.ts`). Both services import it as the workspace dependency `@enterprise-sync/shared`, so run the build (or the watcher) before starting them from a clean checkout. `start-dev.sh` does this automatically.

## Notes

- The package is `private` and is not published to a registry.
- It uses the same Node.js/TypeScript versions as the rest of the workspace.
