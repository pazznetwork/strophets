import { SASLMechanismBase } from './sasl';
import { Connection } from './connection';

export class SASLAnonymous extends SASLMechanismBase {
  /** PrivateConstructor: SASLAnonymous
   *  SASL ANONYMOUS authentication.
   */
  constructor() {
    super('ANONYMOUS', false, 20);
  }

  onChallenge(_connection: Connection): Promise<string> {
    return Promise.resolve('');
  }

  test(connection: Connection): boolean {
    return connection.authcid === null;
  }
}
