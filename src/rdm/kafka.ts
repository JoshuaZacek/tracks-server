import { Kafka, logLevel, type SASLOptions } from 'kafkajs';

/** Connection details from an RDM product's Pub/Sub section (Confluent Cloud: SASL over TLS). */
export interface KafkaSettings {
  bootstrap: string;
  topic: string;
  groupId: string;
  username: string;
  password: string;
  mechanism: 'plain' | 'scram-sha-256' | 'scram-sha-512';
}

export function createKafka(settings: KafkaSettings, name: string, clientId = 'tracks-server') {
  const missing = (['bootstrap', 'topic', 'groupId', 'username', 'password'] as const).filter((k) => !settings[k]);
  if (missing.length) throw new Error(`${name}: missing ${missing.join(', ')} (see .env.example)`);
  return new Kafka({
    clientId,
    brokers: settings.bootstrap.split(',').map((b) => b.trim()),
    ssl: true,
    sasl: { mechanism: settings.mechanism, username: settings.username, password: settings.password } as SASLOptions,
    logLevel: logLevel.WARN,
  });
}
