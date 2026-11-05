import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import { connectDatabase, disconnectDatabase } from '../database/connection.js';
import {
  CompanyModel,
  UserModel,
  MembershipModel,
  PlatformAdminModel,
  QuarryModel,
  QuarryPermissionModel,
  CompanySyncStateModel,
  FolderModel,
} from '../database/models/index.js';
import { CompanyStatus, UserStatus, MembershipRole, STANDARD_FOLDERS } from '../types/index.js';

async function seed() {
  console.log('[Seed] Connecting to MongoDB...');
  await connectDatabase();

  try {
    // 1. Platform Admin
    let platformAdmin = await UserModel.findOne({ username: 'superadmin' });
    if (!platformAdmin) {
      const initialPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD || 'Admin@123456';
      const passwordHash = await bcrypt.hash(initialPassword, 10);
      platformAdmin = await UserModel.create({
        _id: uuidv4(),
        auth_user_id: 'auth-superadmin',
        username: 'superadmin',
        normalized_username: 'superadmin',
        email: 'superadmin@quarryvault.internal',
        full_name: 'Platform Superadmin',
        password_hash: passwordHash,
        status: UserStatus.active,
        must_change_password: false,
      });
      console.log(`[Seed] Created Platform Admin User: superadmin (${platformAdmin._id})`);
    } else {
      console.log(`[Seed] Platform Admin User already exists (${platformAdmin._id})`);
    }

    let platformAdminAuthority = await PlatformAdminModel.findOne({ auth_user_id: platformAdmin.auth_user_id });
    if (!platformAdminAuthority) {
      platformAdminAuthority = await PlatformAdminModel.create({
        _id: uuidv4(),
        auth_user_id: platformAdmin.auth_user_id,
        email: platformAdmin.email,
        full_name: platformAdmin.full_name,
        status: UserStatus.active,
      });
      console.log(`[Seed] Created Platform Admin Authority Document (${platformAdminAuthority._id}) for auth_user_id: ${platformAdmin.auth_user_id}`);
    } else {
      console.log(`[Seed] Platform Admin Authority Document already exists (${platformAdminAuthority._id})`);
    }

    // 2. Demo Company
    let demoCompany = await CompanyModel.findOne({ name: 'Demo Quarry Co' });
    if (!demoCompany) {
      demoCompany = await CompanyModel.create({
        _id: uuidv4(),
        name: 'Demo Quarry Co',
        status: CompanyStatus.active,
        quota_bytes: 5 * 1024 * 1024 * 1024, // 5 GiB
        used_bytes: 0,
        max_users: 50,
      });

      await CompanySyncStateModel.create({
        _id: uuidv4(),
        company_id: demoCompany._id,
        last_change_seq: 0,
      });
      console.log(`[Seed] Created Demo Company: Demo Quarry Co (${demoCompany._id})`);
    } else {
      console.log(`[Seed] Demo Company already exists (${demoCompany._id})`);
    }

    // 3. Company Admin
    let companyAdmin = await UserModel.findOne({ username: 'company_admin' });
    if (!companyAdmin) {
      const passwordHash = await bcrypt.hash('CompanyAdmin@123', 10);
      companyAdmin = await UserModel.create({
        _id: uuidv4(),
        auth_user_id: 'auth-company-admin',
        username: 'company_admin',
        email: 'company_admin@example.com',
        full_name: 'Quarry Admin',
        password_hash: passwordHash,
        status: UserStatus.active,
        must_change_password: false,
      });

      await MembershipModel.create({
        _id: uuidv4(),
        user_id: companyAdmin._id,
        company_id: demoCompany._id,
        role: MembershipRole.company_admin,
      });
      console.log(`[Seed] Created Company Admin: company_admin / CompanyAdmin@123 (${companyAdmin._id})`);
    }

    // 4. Employee User
    let employeeUser = await UserModel.findOne({ username: 'employee1' });
    if (!employeeUser) {
      const passwordHash = await bcrypt.hash('Employee@123', 10);
      employeeUser = await UserModel.create({
        _id: uuidv4(),
        auth_user_id: 'auth-employee-1',
        username: 'employee1',
        email: 'employee1@example.com',
        full_name: 'Site Engineer Mina',
        password_hash: passwordHash,
        status: UserStatus.active,
        must_change_password: false,
      });

      await MembershipModel.create({
        _id: uuidv4(),
        user_id: employeeUser._id,
        company_id: demoCompany._id,
        role: MembershipRole.employee,
      });
      console.log(`[Seed] Created Employee: employee1 / Employee@123 (${employeeUser._id})`);
    }

    // 5. Quarries
    let quarryNorth = await QuarryModel.findOne({ company_id: demoCompany._id, name: 'North Granite Pit' });
    if (!quarryNorth) {
      quarryNorth = await QuarryModel.create({
        _id: uuidv4(),
        company_id: demoCompany._id,
        name: 'North Granite Pit',
        quarry_number: 'Q-001',
        quarry_type: 'جرانيت',
        status: 'active',
      });
      console.log(`[Seed] Created Quarry: North Granite Pit (${quarryNorth._id})`);
    }

    let quarrySouth = await QuarryModel.findOne({ company_id: demoCompany._id, name: 'South Marble Quarry' });
    if (!quarrySouth) {
      quarrySouth = await QuarryModel.create({
        _id: uuidv4(),
        company_id: demoCompany._id,
        name: 'South Marble Quarry',
        quarry_number: 'Q-002',
        quarry_type: 'رخام',
        status: 'active',
      });
      console.log(`[Seed] Created Quarry: South Marble Quarry (${quarrySouth._id})`);
    }

    // Ensure standard folders exist for seeded quarries
    for (const q of [quarryNorth, quarrySouth]) {
      const existing = await FolderModel.find({ quarry_id: q._id, is_standard: true }).lean();
      if (existing.length === 0) {
        await FolderModel.insertMany(
          STANDARD_FOLDERS.map((sf) => ({
            company_id: demoCompany._id,
            quarry_id: q._id,
            parent_id: null,
            name: sf.name,
            is_standard: true,
            standard_order: sf.order,
            standard_key: sf.key,
            version: 1,
          }))
        );
        console.log(`[Seed] Created 8 standard folders for ${q.name}`);
      }
    }

    // 6. Permissions for Employee
    const existingPerm = await QuarryPermissionModel.findOne({
      user_id: employeeUser._id,
      quarry_id: quarryNorth._id,
    });
    if (!existingPerm) {
      await QuarryPermissionModel.create({
        _id: uuidv4(),
        user_id: employeeUser._id,
        quarry_id: quarryNorth._id,
        can_view: true,
        can_upload: true,
        can_download: true,
        can_delete: false,
      });
      console.log(`[Seed] Granted employee permissions for North Granite Pit`);
    }

    console.log('[Seed] Completed successfully.');
  } catch (error) {
    console.error('[Seed] Error during seeding:', error);
    process.exit(1);
  } finally {
    await disconnectDatabase();
  }
}

seed();
