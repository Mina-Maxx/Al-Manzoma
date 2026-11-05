import fs from 'fs';

const filePath = 'C:/Users/Mina Max/Downloads/0xAnub1sX/quarryvault/android/app/src/main/java/com/quarryvault/employee/data/api/QuarryVaultApiClient.kt';
let code = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');

// 1. In executeRequest: add enrichRequest
const oldExecute = `    protected open fun <T> executeRequest(
        request: Request,
        parser: (String) -> T
    ): ApiResult<T> {
        val builder = request.newBuilder()
        if (request.header("X-Client-Application") == null) {
            builder.header("X-Client-Application", "android")
        }
        if (request.header("X-App-Version-Code") == null && clientVersionCode > 0) {
            builder.header("X-App-Version-Code", clientVersionCode.toString())
        }
        val sid = currentSessionId
        if (!sid.isNullOrBlank() && request.header("X-Session-Id") == null) {
            builder.header("X-Session-Id", sid)
        }
        val reqWithHeaders = builder.build()
        return try {`;

const newExecute = `    protected fun enrichRequest(request: Request): Request {
        val builder = request.newBuilder()
        if (request.header("X-Client-Application") == null) {
            builder.header("X-Client-Application", "android")
        }
        if (request.header("X-App-Version-Code") == null && clientVersionCode > 0) {
            builder.header("X-App-Version-Code", clientVersionCode.toString())
        }
        val sid = currentSessionId
        if (!sid.isNullOrBlank() && request.header("X-Session-Id") == null) {
            builder.header("X-Session-Id", sid)
        }
        return builder.build()
    }

    protected open fun <T> executeRequest(
        request: Request,
        parser: (String) -> T
    ): ApiResult<T> {
        val reqWithHeaders = enrichRequest(request)
        return try {`;

if (!code.includes(oldExecute)) {
  console.error('oldExecute not found');
  process.exit(1);
}
code = code.replace(oldExecute, newExecute);

// 2. In deleteDocument:
const oldDeleteDoc = `        try {
            client.newCall(builder.build()).execute().use { response ->`;
const newDeleteDoc = `        val reqWithHeaders = enrichRequest(builder.build())

        try {
            client.newCall(reqWithHeaders).execute().use { response ->`;
if (!code.includes(oldDeleteDoc)) {
  console.error('oldDeleteDoc not found');
  process.exit(1);
}
code = code.replace(oldDeleteDoc, newDeleteDoc);

// 3. In getDocumentPayload:
const oldGetPayload = `        try {
            client.newCall(request).execute().use { response ->`;
const newGetPayload = `        val reqWithHeaders = enrichRequest(request)

        try {
            client.newCall(reqWithHeaders).execute().use { response ->`;
if (!code.includes(oldGetPayload)) {
  console.error('oldGetPayload not found');
  process.exit(1);
}
code = code.replace(oldGetPayload, newGetPayload);

// 4. In downloadApkWithProgress:
const oldDownloadApk = `            downloadClient.newCall(request).execute().use { response ->`;
const newDownloadApk = `            val reqWithHeaders = enrichRequest(request)
            downloadClient.newCall(reqWithHeaders).execute().use { response ->`;
if (!code.includes(oldDownloadApk)) {
  console.error('oldDownloadApk not found');
  process.exit(1);
}
code = code.replace(oldDownloadApk, newDownloadApk);

// 5. In permanentlyDeleteDocument:
const oldPermDelete = `        val sid = currentSessionId
        if (!sid.isNullOrBlank()) {
            builder.header("X-Session-Id", sid)
        }
        val req = builder.build()

        try {
            client.newCall(req).execute().use { response ->`;
const newPermDelete = `        val req = enrichRequest(builder.build())

        try {
            client.newCall(req).execute().use { response ->`;
if (!code.includes(oldPermDelete)) {
  console.error('oldPermDelete not found');
  process.exit(1);
}
code = code.replace(oldPermDelete, newPermDelete);

fs.writeFileSync(filePath, code.replace(/\n/g, '\r\n'), 'utf8');
console.log('QuarryVaultApiClient updated successfully!');
