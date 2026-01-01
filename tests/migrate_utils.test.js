const assert = require("assert");
const U = require("../migrate_utils.js");

function testBuildSearchUrl() {
  assert.strictEqual(
    U.buildSearchUrl("mangadex", "One Piece"),
    "https://mangadex.org/search?q=One%20Piece"
  );
  assert.strictEqual(
    U.buildSearchUrl("anilist", "Berserk"),
    "https://anilist.co/search/manga?search=Berserk"
  );
  assert.strictEqual(
    U.buildSearchUrl("mal", "20th Century Boys"),
    "https://myanimelist.net/manga.php?q=20th%20Century%20Boys&cat=manga"
  );
  assert.strictEqual(
    U.buildSearchUrl("mangaupdates", "Oshi no Ko"),
    "https://www.mangaupdates.com/search.html?search=Oshi%20no%20Ko"
  );
}

function testCsv() {
  const items = [
    {
      title: 'A "quote", and comma',
      mangapark_url: "https://example.com/x",
      comic_id: "123",
      last_read_serial: "10",
      last_read_url: "https://example.com/c",
      captured_at: "2026-01-01T00:00:00.000Z",
    },
  ];
  const csv = U.makeCsv(items);
  assert.ok(csv.includes('\"A \"\"quote\"\", and comma\"'));
  assert.ok(csv.split("\n").length === 2);
}

function testMatchUtils() {
  assert.strictEqual(U.normalizeForMatch("  One-Piéce!! "), "one piece");
  assert.ok(U.diceCoefficient("One Piece", "One Piece") === 1);
  assert.ok(U.diceCoefficient("One Piece", "One") < 1);
  assert.ok(U.diceCoefficient("Berserk", "Berserker") > 0.6);
}

function run() {
  testBuildSearchUrl();
  testCsv();
  testMatchUtils();
  console.log("migrate_utils.test.js OK");
}

run();

