-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "gold" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Account_tokenHash_key" ON "Account"("tokenHash");
