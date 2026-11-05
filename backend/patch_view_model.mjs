import fs from 'fs';

const filePath = 'C:/Users/Mina Max/Downloads/0xAnub1sX/quarryvault/android/app/src/main/java/com/quarryvault/employee/ui/screens/EmployeeAppViewModel.kt';
let code = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');

// 1. In deleteFolder:
const oldDeleteFolder = `        val quarry = _uiState.value.quarries.find { it.id == quarryId } ?: _uiState.value.selectedQuarry
        if (quarry != null && !quarry.permissions.canDelete) {`;
const newDeleteFolder = `        val quarry = _uiState.value.quarries.find { it.id == quarryId } ?: _uiState.value.selectedQuarry
        val isCompanyAdmin = _uiState.value.profile?.role == "company_admin"
        if (quarry != null && !isCompanyAdmin && !quarry.permissions.canDelete) {`;
if (!code.includes(oldDeleteFolder)) {
  console.error('oldDeleteFolder not found');
  process.exit(1);
}
code = code.replace(oldDeleteFolder, newDeleteFolder);

// 2. In isDocumentDownloadAllowed and isDocumentViewAllowed:
const oldPermChecks = `    private fun isDocumentDownloadAllowed(document: Document): Boolean {
        val quarry = _uiState.value.selectedQuarry ?: return false
        return document.status.equals("available", ignoreCase = true) &&
                quarry.id == document.quarryId &&
                quarry.permissions.canDownload
    }

    private fun isDocumentViewAllowed(document: Document): Boolean {
        val quarry = _uiState.value.selectedQuarry ?: return false
        return document.status.equals("available", ignoreCase = true) &&
                quarry.id == document.quarryId && quarry.permissions.canView
    }`;
const newPermChecks = `    private fun isDocumentDownloadAllowed(document: Document): Boolean {
        val quarry = _uiState.value.selectedQuarry ?: return false
        val isCompanyAdmin = _uiState.value.profile?.role == "company_admin"
        return document.status.equals("available", ignoreCase = true) &&
                quarry.id == document.quarryId &&
                (isCompanyAdmin || quarry.permissions.canDownload)
    }

    private fun isDocumentViewAllowed(document: Document): Boolean {
        val quarry = _uiState.value.selectedQuarry ?: return false
        val isCompanyAdmin = _uiState.value.profile?.role == "company_admin"
        return document.status.equals("available", ignoreCase = true) &&
                quarry.id == document.quarryId &&
                (isCompanyAdmin || quarry.permissions.canView)
    }`;
if (!code.includes(oldPermChecks)) {
  console.error('oldPermChecks not found');
  process.exit(1);
}
code = code.replace(oldPermChecks, newPermChecks);

// 3. In renameDocument:
const oldRename = `        val quarry = _uiState.value.quarries.find { it.id == quarryId } ?: _uiState.value.selectedQuarry
        if (quarry != null && !quarry.permissions.canView) {`;
const newRename = `        val quarry = _uiState.value.quarries.find { it.id == quarryId } ?: _uiState.value.selectedQuarry
        val isCompanyAdmin = _uiState.value.profile?.role == "company_admin"
        if (quarry != null && !isCompanyAdmin && !quarry.permissions.canView) {`;
if (!code.includes(oldRename)) {
  console.error('oldRename not found');
  process.exit(1);
}
code = code.replace(oldRename, newRename);

// 4. In deleteDocument:
const oldDeleteDoc = `        val quarry = _uiState.value.quarries.find { it.id == quarryId } ?: _uiState.value.selectedQuarry
        if (quarry != null && !quarry.permissions.canDelete) {`;
const newDeleteDoc = `        val quarry = _uiState.value.quarries.find { it.id == quarryId } ?: _uiState.value.selectedQuarry
        val isCompanyAdmin = _uiState.value.profile?.role == "company_admin"
        if (quarry != null && !isCompanyAdmin && !quarry.permissions.canDelete) {`;
if (!code.includes(oldDeleteDoc)) {
  console.error('oldDeleteDoc not found');
  process.exit(1);
}
code = code.replace(oldDeleteDoc, newDeleteDoc);

fs.writeFileSync(filePath, code.replace(/\n/g, '\r\n'), 'utf8');
console.log('EmployeeAppViewModel updated successfully!');
