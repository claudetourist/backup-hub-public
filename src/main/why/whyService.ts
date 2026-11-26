import type { WhyRequest, WhyResult } from '../../shared/decisions';
import { whyFile, type WhyDeps } from './whyFile';

/** What the window calls for "Why?" on a file: one read-only answer from the index (see whyFile.ts). */
export class WhyService {
  constructor(private readonly deps: WhyDeps) {}

  why(request: WhyRequest): WhyResult {
    return whyFile(this.deps, request);
  }
}
