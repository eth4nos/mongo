/**
 * Test TTL collections with replication
 *  Part 1: Initiate replica set. Insert some docs and create a TTL index.
 *          Check that the correct # of docs age out.
 *  Part 2: Add a new member to the set. Check that it also gets the correct # of docs.
 *  Part 3: Change the TTL expireAfterSeconds field and check successful propogation to secondary.
 *  @tags: [requires_replication]
 */

load("jstests/replsets/rslib.js");

var rt = new ReplSetTest({name: "ttl_repl", nodes: 2});

/******** Part 1 ***************/

// setup set
var nodes = rt.startSet();
rt.initiate();
var master = rt.getPrimary();
rt.awaitSecondaryNodes();
var slave1 = rt._slaves[0];

// shortcuts
var masterdb = master.getDB('d');
var slave1db = slave1.getDB('d');
var mastercol = masterdb['c'];
var slave1col = slave1db['c'];

mastercol.drop();
masterdb.createCollection(mastercol.getName());

// create new collection. insert 24 docs, aged at one-hour intervalss
now = (new Date()).getTime();
var bulk = mastercol.initializeUnorderedBulkOp();
for (i = 0; i < 24; i++) {
    bulk.insert({x: new Date(now - (3600 * 1000 * i))});
}
assert.writeOK(bulk.execute());
rt.awaitReplication();
assert.eq(24, mastercol.count(), "docs not inserted on primary");
assert.eq(24, slave1col.count(), "docs not inserted on secondary");

print("Initial Stats:");
print("Master:");
printjson(mastercol.stats());
print("Slave1:");
printjson(slave1col.stats());

// create TTL index, wait for TTL monitor to kick in, then check that
// the correct number of docs age out
var initialExpireAfterSeconds = 20000;
assert.commandWorked(
    mastercol.ensureIndex({x: 1}, {expireAfterSeconds: initialExpireAfterSeconds}));
rt.awaitReplication();

sleep(70 * 1000);  // TTL monitor runs every 60 seconds, so wait 70

print("Stats after waiting for TTL Monitor:");
print("Master:");
printjson(mastercol.stats());
print("Slave1:");
printjson(slave1col.stats());

assert.eq(6, mastercol.count(), "docs not deleted on primary");
assert.eq(6, slave1col.count(), "docs not deleted on secondary");

/******** Part 2 ***************/

// add a new secondary, wait for it to fully join
var slave = rt.add();
var config = rt.getReplSetConfig();
config.version = rt.getReplSetConfigFromNode().version + 1;
reconfig(rt, config);

var slave2col = slave.getDB('d')['c'];

// check that the new secondary has the correct number of docs
print("New Slave stats:");
printjson(slave2col.stats());

assert.eq(6, slave2col.count(), "wrong number of docs on new secondary");

/******* Part 3 *****************/
// Check that the collMod command successfully updates the expireAfterSeconds field
masterdb.runCommand({collMod: "c", index: {keyPattern: {x: 1}, expireAfterSeconds: 10000}});
rt.awaitReplication();

function getTTLTime(theCollection, theKey) {
    var indexes = theCollection.getIndexes();
    for (var i = 0; i < indexes.length; i++) {
        if (friendlyEqual(theKey, indexes[i].key))
            return indexes[i].expireAfterSeconds;
    }
    throw "not found";
}

printjson(masterdb.c.getIndexes());
assert.eq(10000, getTTLTime(masterdb.c, {x: 1}));
assert.eq(10000, getTTLTime(slave1db.c, {x: 1}));

// Verify the format of TTL collMod oplog entry. The old expiration time should be saved,
// and index key patterns should be normalized to index names.
var masterOplog = master.getDB('local').oplog.rs.find().sort({$natural: 1}).toArray();
var collModEntry = masterOplog.find(op => op.o.collMod);

assert(collModEntry, "collMod entry was not present in the oplog.");
assert.eq(initialExpireAfterSeconds, collModEntry.o2["expireAfterSeconds_old"]);
assert.eq("x_1", collModEntry.o["index"]["name"]);

// finish up
rt.stopSet();
