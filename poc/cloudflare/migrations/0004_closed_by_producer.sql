ALTER TABLE streams ADD COLUMN closed_by_producer_id TEXT;
ALTER TABLE streams ADD COLUMN closed_by_epoch INTEGER;
ALTER TABLE streams ADD COLUMN closed_by_seq INTEGER;
