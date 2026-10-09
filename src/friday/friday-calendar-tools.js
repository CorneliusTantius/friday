import { Type } from 'typebox';

const result = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] });

export function createFridayCalendarTools({ calendar, onSensitiveRead = () => {} } = {}) {
  if (!calendar) return [];
  return [{
    name: 'calendar_list_events',
    label: 'Read Calendar agenda',
    description: 'Read up to 50 events from the connected primary Google Calendar for an explicit time range no longer than 90 days. Read-only. Returned provider data is part of this conversation; request only events needed to answer the user.',
    parameters: Type.Object({
      timeMin: Type.String({ minLength: 1, maxLength: 40, description: 'ISO 8601 start time with timezone.' }),
      timeMax: Type.String({ minLength: 1, maxLength: 40, description: 'ISO 8601 end time with timezone, at most 90 days after start.' }),
    }),
    async execute(_id, { timeMin, timeMax }) {
      onSensitiveRead();
      return result(await calendar.listEvents({ timeMin, timeMax }));
    },
  }];
}
