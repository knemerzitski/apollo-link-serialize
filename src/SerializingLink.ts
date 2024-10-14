import {
  ApolloLink,
  FetchResult,
  NextLink,
  Observable,
  Operation,
} from '@apollo/client/core';
import { Observer } from 'zen-observable-ts';
import { extractKey } from './extractKey';

export interface OperationQueueEntry {
  operation: Operation;
  forward: NextLink;
  observer: Observer<FetchResult>;
  subscription?: { unsubscribe: () => void };
}

// Serialize queries with the same context.serializationKey, meaning that
// all previous queries must complete for the next query with the same
// context.serializationKey to be started.
export default class SerializingLink extends ApolloLink {
  private opQueues: { [key: string]: OperationQueueEntry[] } = {};

  static readonly SERIALIZE = 'serializationKey';
  /**
   * Use this key to combine both document directive and `serializationKeyDirective`
   */
  static readonly SERIALIZE_DIRECTIVE = 'serializationKeyDirective';

  public override request(origOperation: Operation, forward?: NextLink) {
    if (forward == null) {
      return null;
    }

    const { operation, key } = extractKey(origOperation);
    if (!key) {
      return forward(operation);
    }

    return new Observable((observer: Observer<FetchResult>) => {
      const entry = { operation, forward, observer };
      this.enqueue(key, entry);

      return () => {
        this.cancelOp(key, entry);
      };
    });
  }

  // Add an operation to the end of the queue. If it is the first operation in the queue, start it.
  private enqueue = (key: string, entry: OperationQueueEntry) => {
    if (!this.opQueues[key]) {
      this.opQueues[key] = [];
    }
    this.opQueues[key].push(entry);
    if (this.opQueues[key].length === 1) {
      this.startFirstOpIfNotStarted(key);
    }
    // console.log('enqueue', key, 'queue length', this.opQueues[key].length);
  };

  // Cancel the operation by removing it from the queue and unsubscribing if it is currently in progress.
  private cancelOp = (key: string, entryToRemove: OperationQueueEntry) => {
    if (!this.opQueues[key]) {
      /* should never happen */ return;
    }
    const idx = this.opQueues[key].findIndex((entry) => entryToRemove === entry);

    if (idx >= 0) {
      const entry = this.opQueues[key][idx];
      if (entry?.subscription) {
        entry.subscription.unsubscribe();
      }
      this.opQueues[key].splice(idx, 1);
    }
    this.startFirstOpIfNotStarted(key);
  };

  // Start the first operation in the queue if it hasn't been started yet
  private startFirstOpIfNotStarted = (key: string) => {
    // At this point, the queue always exists, but it may not have any elements
    // If it has no elements, we free up the memory it was using.
    if (this.opQueues[key] != null && this.opQueues[key].length === 0) {
      delete this.opQueues[key];
      return;
    }
    if (this.opQueues?.[key]?.[0]) {
      const { operation, forward, observer, subscription } = this.opQueues[key][0];
      if (subscription) {
        return;
      }
      this.opQueues[key][0].subscription = forward(operation).subscribe({
        next: (v: FetchResult) => observer.next && observer.next(v),
        error: (e: Error) => {
          if (observer.error) {
            observer.error(e);
          }
        },
        complete: () => {
          if (observer.complete) {
            observer.complete();
          }
        },
      });
    }
  };
}
