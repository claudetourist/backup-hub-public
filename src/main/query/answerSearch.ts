import type { SearchRequest, SearchResponse } from '../../shared/search';
import type { Db } from '../db/connection';
import { indexedSearch } from './searchIndexQuery';
import { searchQuery } from './searchQuery';

/**
 * The one entry the worker and the main-thread fallback call for Files search: through the search index when it is ready and can answer
 * the request (searchIndexQuery.ts), else the plain search (searchQuery.ts), which never depends on the index.
 */
export function answerSearch(db: Db, request: SearchRequest): SearchResponse {
  return indexedSearch(db, request) ?? searchQuery(db, request);
}
