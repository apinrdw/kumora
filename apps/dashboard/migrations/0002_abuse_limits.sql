create table "mailCap" ("id" text not null primary key, "address" text not null unique, "count" integer not null, "windowStart" bigint not null);

create table "rateLimit" ("id" text not null primary key, "key" text not null unique, "count" integer not null, "lastRequest" bigint not null);
