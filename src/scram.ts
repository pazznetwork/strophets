import { arrayBufToBase64, base64ToArrayBuf, stringToArrayBuf, xorArrayBuffers } from './utils';
import { warn } from './log';
import { Connection } from './connection';

async function scramClientProof(authMessage: string, clientKey: ArrayBufferLike, hashName: string) {
  const storedKey = await window.crypto.subtle.importKey(
    'raw',
    await window.crypto.subtle.digest(hashName, clientKey),
    { name: 'HMAC', hash: hashName },
    false,
    ['sign']
  );
  const clientSignature = await window.crypto.subtle.sign('HMAC', storedKey, stringToArrayBuf(authMessage));

  return xorArrayBuffers(clientKey, clientSignature);
}

/* This function parses the information in a SASL SCRAM challenge response,
 * into an object of the form
 * { nonce: String,
 *   salt:  ArrayBuffer,
 *   iter:  Int
 * }
 * Returns undefined on failure.
 */
function scramParseChallenge(challenge: string) {
  let nonce, salt, iter;
  const attribMatch = /([a-z]+)=([^,]+)(,|$)/;
  while (challenge.match(attribMatch)) {
    const matches = challenge.match(attribMatch);
    challenge = challenge.replace(matches[0], '');
    switch (matches[1]) {
      case 'r':
        nonce = matches[2];
        break;
      case 's':
        salt = base64ToArrayBuf(matches[2]);
        break;
      case 'i':
        iter = parseInt(matches[2], 10);
        break;
      default:
        return undefined;
    }
  }

  // Consider iteration counts less than 4096 insecure, as reccommended by
  // RFC 5802
  if (isNaN(iter) || iter < 4096) {
    warn('Failing SCRAM authentication because server supplied iteration count < 4096.');
    return undefined;
  }

  if (!salt) {
    warn('Failing SCRAM authentication because server supplied incorrect salt.');
    return undefined;
  }

  return { nonce, salt, iter };
}

/* Derive the client and server keys given a string password,
 * a hash name, and a bit length.
 * Returns an object of the following form:
 * { ck: ArrayBuffer, the client key
 *   sk: ArrayBuffer, the server key
 * }
 */
async function scramDeriveKeys(password: string, salt: ArrayBufferLike, iter: number, hashName: string, hashBits: number) {
  const saltedPasswordBits = await window.crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: iter, hash: { name: hashName } },
    await window.crypto.subtle.importKey('raw', stringToArrayBuf(password), 'PBKDF2', false, ['deriveBits']),
    hashBits
  );
  const saltedPassword = await window.crypto.subtle.importKey('raw', saltedPasswordBits, { name: 'HMAC', hash: hashName }, false, ['sign']);

  return {
    ck: await window.crypto.subtle.sign('HMAC', saltedPassword, stringToArrayBuf('Client Key')),
    sk: await window.crypto.subtle.sign('HMAC', saltedPassword, stringToArrayBuf('Server Key'))
  };
}

async function scramServerSign(authMessage: string, sk: ArrayBufferLike, hashName: string) {
  const serverKey = await window.crypto.subtle.importKey('raw', sk, { name: 'HMAC', hash: hashName }, false, ['sign']);

  return window.crypto.subtle.sign('HMAC', serverKey, stringToArrayBuf(authMessage));
}

// Generate an ASCII nonce (not containing the ',' character)
function generate_cnonce() {
  // generate 16 random bytes of nonce, base64 encoded
  const bytes = new Uint8Array(16);
  return arrayBufToBase64(crypto.getRandomValues(bytes).buffer);
}

/* On success, sets
 * connection_sasl_data["server-signature"]
 * and
 * connection._sasl_data.keys
 *
 * The server signature should be verified after this function completes..
 *
 * On failure, returns connection._sasl_failure_cb();
 */
export async function scramResponse(connection: Connection, challenge: string, hashName: string, hashBits: number) {
  const cnonce = connection.saslData.cnonce as string;
  const challengeData = scramParseChallenge(challenge);

  // The RFC requires that we verify the (server) nonce has the client
  // nonce as an initial substring.
  if (!challengeData && challengeData?.nonce.slice(0, cnonce.length) !== cnonce) {
    warn('Failing SCRAM authentication because server supplied incorrect nonce.');
    connection.saslData = {};
    return connection.saslFailureCb();
  }

  let clientKey, serverKey;

  // Either restore the client key and server key passed in, or derive new ones
  if (
    typeof connection.pass !== 'string' &&
    connection.pass?.name === hashName &&
    connection.pass?.salt === arrayBufToBase64(challengeData.salt) &&
    connection.pass?.iter === challengeData.iter
  ) {
    clientKey = base64ToArrayBuf(connection.pass.ck);
    serverKey = base64ToArrayBuf(connection.pass.sk);
  } else if (typeof connection.pass === 'string') {
    const keys = await scramDeriveKeys(connection.pass, challengeData.salt, challengeData.iter, hashName, hashBits);
    clientKey = keys.ck;
    serverKey = keys.sk;
  } else {
    connection.saslFailureCb();
    return new Error('SASL SCRAM ERROR');
  }

  const clientFirstMessageBare = connection.saslData['client-first-message-bare'];
  const serverFirstMessage = challenge;
  const clientFinalMessageBare = `c=biws,r=${challengeData.nonce}`;

  const authMessage = `${clientFirstMessageBare},${serverFirstMessage},${clientFinalMessageBare}`;

  const clientProof = await scramClientProof(authMessage, clientKey, hashName);
  const serverSignature = await scramServerSign(authMessage, serverKey, hashName);

  connection.saslData['server-signature'] = arrayBufToBase64(serverSignature);
  connection.saslData.keys = {
    name: hashName,
    iter: challengeData.iter,
    salt: arrayBufToBase64(challengeData.salt),
    ck: arrayBufToBase64(clientKey),
    sk: arrayBufToBase64(serverKey)
  };

  return `${clientFinalMessageBare},p=${arrayBufToBase64(clientProof)}`;
}

// Returns a string containing the client first message
export function clientChallenge(connection: Connection, test_cnonce: string) {
  const cnonce = test_cnonce || generate_cnonce();
  const client_first_message_bare = `n=${connection.authcid},r=${cnonce}`;
  connection.saslData.cnonce = cnonce;
  connection.saslData['client-first-message-bare'] = client_first_message_bare;
  return `n,,${client_first_message_bare}`;
}
