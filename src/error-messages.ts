import { Status } from './status';

export const errorMessages = {
  [Status.ERROR]: 'An error occurred connecting',
  [Status.CONNFAIL]: 'The connection failed',
  [Status.AUTHFAIL]: 'The authentication failed',
  [Status.CONNTIMEOUT]: 'The connection timed out'
};
