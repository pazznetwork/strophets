import { SASLMechanismBase } from './sasl';
import { clientChallenge, scramResponse } from './scram';
import { Connection } from './connection';

export class SASLSHA512 extends SASLMechanismBase {
  /** PrivateConstructor: SASLSHA512
   *  SASL SCRAM SHA 512 authentication.
   */
  constructor() {
    super('SCRAM-SHA-512', true, 72);
  }

  test(connection: Connection): boolean {
    return connection.authcid !== null;
  }

  async onChallenge(connection: Connection, challenge?: string): Promise<string> {
    return (await scramResponse(connection, challenge, 'SHA-512', 512)).toString();
  }

  async clientChallenge(connection: Connection, test_cnonce: string): Promise<string> {
    return clientChallenge(connection, test_cnonce);
  }
}
