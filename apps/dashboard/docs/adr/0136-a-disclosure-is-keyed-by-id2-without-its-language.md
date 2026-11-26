# A disclosure is keyed by Id2 without its language

IDX lists each disclosure once per language, and its `Id2` is the publish time, a dash, the disclosure's number, then `_id-id` or `_en-us`, as `20261124230949-02894/FMS/OPS-BTIM/XI/26_id-id`. `NoPengumuman` alone repeats across different disclosures, so it can't name one. The disclosure archive keys a disclosure by `Id2` with the language suffix dropped: both versions sit under one key in the bucket (`disclosures/<key>/id.json`, `en.json`, `files/<path>`, the key URI-encoded since it holds slashes), and ArchiveDb's `disclosure_version` and `disclosure_attachment` rows carry it (`archive-migrations/0005_disclosure_index.sql`). A file both versions list is one `disclosure_attachment` row, so it is stored once. The key's first eight digits are its disclosure day in WIB. Changing the key means moving every stored object and index row.

Sites:
- `apps/dashboard/src/server/disclosures/key.ts`

Source: apinrdw/kumora#715, apinrdw/kumora#716
