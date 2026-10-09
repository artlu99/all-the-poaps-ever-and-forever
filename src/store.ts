// Storage interface shared by both runtimes.
// Workers: Turso (libsql). Bun self-host: local SQLite file. Same schema.

export interface TokenRow {
  poap_id: number;
  drop_id: number;
  minted_on: number;
  network: string;
  title: string;
  start_date: string;
  city: string | null;
  country: string | null;
  fancy_id: string;
  description: string | null;
  event_url: string | null;
  is_virtual: number | null;
}

export interface ArtworkZipEntry {
  hdr: number; // absolute byte offset of the local file header inside archive.zip
  off: number; // absolute byte offset of the compressed data
  size: number; // compressed size
  method: number; // 0 = stored, 8 = deflate
}

export interface POAPStore {
  /** Tokens for one owner (lowercase 0x-address), newest mints first. */
  getCollection(owner: string, limit: number): Promise<{ rows: TokenRow[]; total: number }>;
  /** Where a drop's artwork lives inside archive.zip. */
  getArtworkZip(dropId: number): Promise<ArtworkZipEntry | null>;
  /** snapshot_at from the archive's metadata table. */
  getSnapshotDate(): Promise<string | null>;
}

export const COLLECTION_COUNT_SQL = 'SELECT COUNT(*) AS total FROM tokens WHERE owner_address = ?';

export const COLLECTION_SQL = `
  SELECT t.poap_id, t.drop_id, t.minted_on, t.network,
         d.title, d.start_date, d.city, d.country, d.fancy_id,
         d.description, d.event_url, d.is_virtual
  FROM tokens t JOIN drops d ON d.drop_id = t.drop_id
  WHERE t.owner_address = ?
  ORDER BY t.minted_on DESC
  LIMIT ?`;
