-- Migration 006: settings table was missing the letterhead fields (tagline, shop location,
-- P.O. box, city/country, second phone) that the frontend already collects and prints on
-- every quotation/invoice — found during the Part 2 audit. Additive, with real defaults
-- matching the actual Roplant letterhead already used throughout the frontend.
BEGIN;

ALTER TABLE settings ADD COLUMN tagline TEXT;
ALTER TABLE settings ADD COLUMN shop_location TEXT;
ALTER TABLE settings ADD COLUMN po_box TEXT;
ALTER TABLE settings ADD COLUMN city_country TEXT;
ALTER TABLE settings ADD COLUMN phone2 TEXT;

UPDATE settings SET
  company_name = 'ROPLANT SERVICE LTD',
  tagline = 'For: Heavy Machines Spare Parts, Cat, Cummins Komatish, Perkins and Others',
  shop_location = 'Shop No. 071, Second Floor, Original Shauriyako',
  po_box = 'P.O Box 137555',
  city_country = 'Kampala-Uganda',
  address = 'Shop No. 071, Second Floor, Original Shauriyako, Kampala-Uganda',
  phone = '+256 0772 916056',
  phone2 = '+256 753 916056',
  email = 'mukasaronald2@gmail.com',
  receipt_footer = 'All accounts are due on demand'
WHERE id = 1;

COMMIT;
