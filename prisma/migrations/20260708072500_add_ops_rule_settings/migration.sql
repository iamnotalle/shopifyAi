CREATE TABLE "OpsRuleSetting" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "profileKey" TEXT NOT NULL DEFAULT 'demo',
    "ruleId" TEXT NOT NULL,
    "value" REAL NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "OpsRuleSetting_profileKey_ruleId_key" ON "OpsRuleSetting"("profileKey", "ruleId");
CREATE INDEX "OpsRuleSetting_profileKey_idx" ON "OpsRuleSetting"("profileKey");
