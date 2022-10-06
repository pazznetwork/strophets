import { clientChallenge, scramResponse } from './scram';
import { SASLMechanismBase } from './sasl';
import { Connection } from './connection';

export class SASLSHA1 extends SASLMechanismBase {
  /** PrivateConstructor: SASLSHA1
   *  SASL SCRAM SHA 1 authentication.
   */
  constructor() {
    super('SCRAM-SHA-1', true, 60);
  }

  test(connection: Connection) {
    return connection.authcid !== null;
  }

  async onChallenge(connection: Connection, challenge?: string): Promise<string> {
    const result = await scramResponse(connection, challenge, 'SHA-1', 160);
    return result.toString();
  }

  async clientChallenge(connection: Connection, test_cnonce: string): Promise<string> {
    return clientChallenge(connection, test_cnonce);
  }
}
