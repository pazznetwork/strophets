import { SASLMechanismBase } from './sasl.js';
import { Connection } from './connection';
import { clientChallenge, scramResponse } from './scram';

export class SASLSHA256 extends SASLMechanismBase {
  /** PrivateConstructor: SASLSHA256
   *  SASL SCRAM SHA 256 authentication.
   */
  constructor() {
    super('SCRAM-SHA-256', true, 70);
  }

  test(connection: Connection): boolean {
    return connection.authcid !== null;
  }

  async onChallenge(connection: Connection, challenge?: string): Promise<string> {
    return (await scramResponse(connection, challenge, 'SHA-256', 256)).toString();
  }

  async clientChallenge(connection: Connection, test_cnonce: string): Promise<string> {
    return clientChallenge(connection, test_cnonce);
  }
}
