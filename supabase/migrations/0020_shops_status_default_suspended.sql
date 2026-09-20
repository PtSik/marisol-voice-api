-- Stage 1 of retiring the `trial` shop status. Safe to apply against the currently deployed code:
-- it only changes what an INSERT with no status gets, and every writer already sends one.
--
-- `trial` was the default from before assisted launch, when a shop was callable the moment it
-- existed. It is now the opposite of how a shop is born: the landing worker creates a `suspended`
-- row and an operator turns it on by hand after confirming readiness with the owner. A default
-- that makes an unfinished row answer the phone is a gate that can be skipped by omission.
--
-- No row carries `trial` today, so there is nothing to migrate. Stage 2 (0021) removes the value
-- from the CHECK and must not be applied until the code that accepts it is no longer deployed.

ALTER TABLE shops ALTER COLUMN status SET DEFAULT 'suspended';
