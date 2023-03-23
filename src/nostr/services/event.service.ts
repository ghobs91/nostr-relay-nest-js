import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { difference, union } from 'lodash';
import { E_EVENT_BROADCAST, TagName } from '../constants';
import { EventRepository } from '../repositories';
import { Event, EventIdSchema, Filter } from '../schemas';
import {
  CommandResultResponse,
  createCommandResultResponse,
  isDeletionEvent,
  isEphemeralEvent,
  isReplaceableEvent,
} from '../utils';

@Injectable()
export class EventService {
  constructor(
    private readonly eventRepository: EventRepository,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async findByFilters(filters: Filter[]): Promise<Event[]> {
    return await this.eventRepository.find(filters);
  }

  async handleEvent(event: Event): Promise<void | CommandResultResponse> {
    if (isReplaceableEvent(event)) {
      return this.handleReplaceableEvent(event);
    }

    if (isEphemeralEvent(event)) {
      return this.handleEphemeralEvent(event);
    }

    if (isDeletionEvent(event)) {
      return this.handleDeletionEvent(event);
    }

    return this.handleRegularEvent(event);
  }

  private async handleDeletionEvent(event: Event) {
    const eventIds = union(
      event.tags
        .filter(
          ([tagName, tagValue]) =>
            tagName === TagName.EVENT &&
            EventIdSchema.safeParse(tagValue).success,
        )
        .map(([, tagValue]) => tagValue),
    );

    if (eventIds.length > 0) {
      const events = await this.eventRepository.find({ ids: eventIds });
      const eventIdsNotBelongToPubkey = events
        .filter((event) => event.pubkey !== event.pubkey)
        .map((event) => event.id);

      const eventIdsToBeDeleted = difference(
        eventIds,
        eventIdsNotBelongToPubkey,
      );
      await this.eventRepository.delete(event.pubkey, eventIdsToBeDeleted);
    }

    return this.handleRegularEvent(event);
  }

  private async handleReplaceableEvent(
    event: Event,
  ): Promise<CommandResultResponse> {
    const oldEvent = await this.eventRepository.findOne({
      kinds: [event.kind],
      authors: [event.pubkey],
    });
    if (oldEvent && oldEvent.created_at > event.created_at) {
      return createCommandResultResponse(
        event.id,
        true,
        'duplicate: the event already exists',
      );
    }

    const success = await this.eventRepository.replace(event, oldEvent?.id);
    if (success) {
      this.broadcastEvent(event);
    }
    return createCommandResultResponse(
      event.id,
      true,
      success ? '' : 'duplicate: the event already exists',
    );
  }

  private handleEphemeralEvent(event: Event): void {
    this.broadcastEvent(event);
  }

  private async handleRegularEvent(
    event: Event,
  ): Promise<CommandResultResponse> {
    const success = await this.eventRepository.create(event);

    if (success) {
      this.broadcastEvent(event);
    }
    return createCommandResultResponse(
      event.id,
      true,
      success ? '' : 'duplicate: the event already exists',
    );
  }

  private broadcastEvent(event: Event) {
    return this.eventEmitter.emit(E_EVENT_BROADCAST, event);
  }
}
