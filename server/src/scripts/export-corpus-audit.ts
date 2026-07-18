import { getAllItems, listAllUsers } from '../db.js';
import { env } from '../env.js';
import { isOwnerUser } from '../owner-access.js';
import { corpusSourceHash, type CorpusExportRecord } from '../corpus-audit.js';

const owner = listAllUsers().find(user => isOwnerUser(user, env.OWNER_GOOGLE_EMAIL));
if (!owner) throw new Error('Owner account not found');

const items: CorpusExportRecord[] = getAllItems(true, owner.id)
  .filter(item => !item.isDeleted)
  .map(item => ({
    id: item.data.id,
    type: item.type,
    sourceHash: corpusSourceHash(item.data),
    wasArchived: item.isArchived === true,
    data: item.data,
  }));

process.stdout.write(JSON.stringify({ version: 1, exportedAt: Date.now(), items }));
