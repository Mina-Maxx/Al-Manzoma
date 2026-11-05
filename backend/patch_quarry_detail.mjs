import fs from 'fs';

const filePath = 'C:/Users/Mina Max/Downloads/0xAnub1sX/quarryvault/android/app/src/main/java/com/quarryvault/employee/ui/screens/QuarryDetailScreen.kt';
let code = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');

// 1. Add isCompanyAdmin
const oldLayout = `    val layoutDirection = if (isAr) LayoutDirection.Rtl else LayoutDirection.Ltr`;
const newLayout = `    val layoutDirection = if (isAr) LayoutDirection.Rtl else LayoutDirection.Ltr
    val isCompanyAdmin = uiState.profile?.role == "company_admin"`;
if (!code.includes(oldLayout)) {
  console.error('oldLayout not found');
  process.exit(1);
}
code = code.replace(oldLayout, newLayout);

// 2. FAB upload
const oldFabUpload = `            floatingActionButton = {
                if (quarry.permissions.canUpload) {`;
const newFabUpload = `            floatingActionButton = {
                if (isCompanyAdmin || quarry.permissions.canUpload) {`;
if (!code.includes(oldFabUpload)) {
  console.error('oldFabUpload not found');
  process.exit(1);
}
code = code.replace(oldFabUpload, newFabUpload);

// 3. Folder onDelete
const oldFolderDelete = `                                onDelete = if (quarry.permissions.canDelete && !folder.isStandard) {`;
const newFolderDelete = `                                onDelete = if ((isCompanyAdmin || quarry.permissions.canDelete) && !folder.isStandard) {`;
if (!code.includes(oldFolderDelete)) {
  console.error('oldFolderDelete not found');
  process.exit(1);
}
code = code.replace(oldFolderDelete, newFolderDelete);

// 4. Empty state upload prompt
const oldEmptyUpload = `                                    if (quarry.permissions.canUpload) {
                                        Spacer(modifier = Modifier.height(4.dp))
                                        Text(
                                            text = if (isAr) "اضغط على زر الرفع لإضافة مستند جديد" else "Use the upload button below to add files",`;
const newEmptyUpload = `                                    if (isCompanyAdmin || quarry.permissions.canUpload) {
                                        Spacer(modifier = Modifier.height(4.dp))
                                        Text(
                                            text = if (isAr) "اضغط على زر الرفع لإضافة مستند جديد" else "Use the upload button below to add files",`;
if (!code.includes(oldEmptyUpload)) {
  console.error('oldEmptyUpload not found');
  process.exit(1);
}
code = code.replace(oldEmptyUpload, newEmptyUpload);

// 5. DocumentCard
const oldCard = `                                canDownload = quarry.permissions.canDownload,
                                canDelete = quarry.permissions.canDelete,`;
const newCard = `                                canDownload = isCompanyAdmin || quarry.permissions.canDownload,
                                canDelete = isCompanyAdmin || quarry.permissions.canDelete,`;
if (!code.includes(oldCard)) {
  console.error('oldCard not found');
  process.exit(1);
}
code = code.replace(oldCard, newCard);

fs.writeFileSync(filePath, code.replace(/\n/g, '\r\n'), 'utf8');
console.log('QuarryDetailScreen updated successfully!');
