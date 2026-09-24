-- Extra request details kept with each pixel request. Classification runs on read, so recording
-- more signals now lets future versions re-sort old hits (e.g. new scanner signatures).
ALTER TABLE hits ADD COLUMN headers TEXT;

-- Housekeeping deletes by age.
CREATE INDEX hits_ts ON hits (ts);
