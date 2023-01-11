import { requestsManager } from 'snyk-request-manager';
import * as debugLib from 'debug';
import * as pMap from 'p-map';
import * as common from './common';
import * as utils from './utils';
import * as customErrors from './customErrors';
import {
  GroupMember,
  GroupOrg,
  PendingProvision,
  v1Group,
  PendingMembership,
  GroupRole,
  PendingInvite
} from './types';

const debug = debugLib('snyk:snykGroup');

export class snykGroup {
  id: string;
  name: string;
  key: string;
  sourceMemberships: v1Group;
  private _members: GroupMember[] = [];
  private _orgs: GroupOrg[] = [];
  private _snykMembershipQueue: any[];
  private _snykMembershipRemovalQueue: any[];
  private _buffer: number = 250;
  private _pendingProvisions: PendingProvision[] = [];
  private _roles: GroupRole[] = [];
  private _requestManager: requestsManager;
  private _customAdminRoleExists: boolean;
  private _customCollaboratorRoleExists: boolean;
  private _pendingInvites: PendingInvite[] = [];


  constructor(
    id: string,
    name: string,
    key: string,
    sourceMemberships:  v1Group,
  ) {
    this._customAdminRoleExists = false;
    this._customCollaboratorRoleExists = false;
    this.id = id;
    this._pendingProvisions = [];
    this.name = name;
    this.key = key;
    this._pendingInvites = [];
    this.sourceMemberships = sourceMemberships;
    this._snykMembershipQueue = [];
    this._snykMembershipRemovalQueue = [];

    this._requestManager = new requestsManager({
      snykToken: this.key,
      userAgentPrefix: 'snyk-user-sync-tool',
      burstSize: 1,
      maxRetryCount: 5,
      period: 1000,

    });

  }

  async init() {
    // initialize group object with members
    try {
      let response = await this._requestManager.request({
        verb: 'GET',
        url: `/group/${this.id}/members`,
      });
      debug(JSON.stringify(response.data, null, 2));
      this._members = response.data;
      this._members = this._members.filter((x) => x.email != null);
    } catch (err: any) {
      utils.log(err);
    }

    try {
      let response = await this._requestManager.request({
        verb: 'GET',
        url: `/orgs`,
      });
      this._orgs = response.data.orgs;
    } catch (err: any) {
      utils.log(err);
    }

    //get roles
    try{
      let response = await this._requestManager.request({
        verb: 'GET',
        url:`/group/${this.id}/roles`
      });
      this._roles = response.data
    } catch (err:any){
      utils.log(err)
    }
    //get pending invites if not auto provisioning
    if (common.AUTO_PROVISION_FLAG == false){
      utils.log("Getting pending invites...")
      try{
        for (const org of this.getUniqueOrgs()){
          //validate that org in membership file exists in group orgs
          let groupOrgNames = this._orgs.map((org)=> org.name)
          let orgId = await this.getOrgIdFromName(org)
  
          if(groupOrgNames.includes(org)){
            let response = await this._requestManager.request({
              verb: 'GET',
              url:`/orgs/${orgId}/invites?version=2022-11-14`,
              useRESTApi: true
            })
            for (const invite of response.data.data){
              this._pendingInvites = this._pendingInvites.concat([
                {
                  orgId: invite.relationships.org.data.id,
                  email: invite.attributes.email,
                  role: invite.attributes.email
                }
              ])
            }
          }
        }
      }catch(error:any){
        utils.log(error)
      }
    }
    //get pending provisions if auto provisioning
    if (common.AUTO_PROVISION_FLAG){
      utils.log("Getting pending user provisions...")
      try {
        for (const org of this.getUniqueOrgs()){
          let groupOrgNames = this._orgs.map((org)=> org.name)
          if (groupOrgNames.includes(org)) {
            let response = await this._requestManager.request({
              verb: 'GET',
              url:`/org/${await this.getOrgIdFromName(org)}/provision`
            })
            for (const currProvision of response.data){
              currProvision.orgId = await this.getOrgIdFromName(org)
              this._pendingProvisions.push(currProvision)
            }
          }
        }
      } catch(error: any) {
        utils.log(error)
      }
    }
  }

  private checkIfUserIsGroupAdmin(userEmail:string): boolean{

    let isUserGroupAdmin: boolean = false;

    
    for(let member of this._members){
      if (member.email == userEmail && member.groupRole == 'admin'){
        isUserGroupAdmin = true;
      }
    }
    
    return isUserGroupAdmin

  }

  //takes in a list of roles and returns a mapping of roles <> role:ids
  private mapRolesToIds(): any{

    let mappedRoles: any = {}
    //map roles to role id
    for (const currRole of this._roles){
      mappedRoles[currRole["name"].toUpperCase()] = currRole["publicId"]
    }

    //if custom admin/collaborator role does not exist then translate admin/collaborator entry in membership file into that
    if(!("ADMIN" in mappedRoles)){
      mappedRoles["ADMIN"] = mappedRoles["ORG ADMIN"]
    } else {
      this._customAdminRoleExists = true
    }
    if(!("COLLABORATOR" in mappedRoles)){
      mappedRoles["COLLABORATOR"] = mappedRoles["ORG COLLABORATOR"]
    } else {
      this._customCollaboratorRoleExists = true
    }
    return mappedRoles
  }

  //takes in a list of orgs and returns a mapping of orgs <> org:ids
  private getUniqueOrgs(){
    let uniqueOrgs:any = []

    //get unique orgs
      let groupMembers:any = this.sourceMemberships
      groupMembers = groupMembers.members

      // get all unique orgs from group members
      groupMembers.map((member:any) => {
        if(!uniqueOrgs.includes(member.org)){
          uniqueOrgs.push(member.org)
        }
      })
    return uniqueOrgs
  }
  
  //checks if a pending invite exists given an email and an orgid
  private pendingInviteExistsInOrg(email:any, orgId:any, ):boolean{
    let pendingInviteExists:boolean = false
      for (const invite of this._pendingInvites){
      if (invite.email.toLowerCase() == email.toLowerCase() && orgId == invite.orgId ){
        pendingInviteExists = true
      }
    }
    return pendingInviteExists
  }

  //checks whether pending invite exists anywhere in group given user email
  private pendingInviteExistsInGroup(email:any):boolean{
    let pendingInviteExists:boolean = false
    for (const invite of this._pendingInvites){
      if (invite.email.toLowerCase() == email.toLowerCase()){
        pendingInviteExists = true
      }
    }
    return pendingInviteExists
  }
  
  //checks if a pending invite exists given an email and an orgid
  private pendingProvisionExists(email:any, orgId:any):boolean{
    let pendingProvisionExists = false;
    for (const provision of this._pendingProvisions){
      if (provision.email.toLowerCase() == email.toLowerCase() && provision.orgId == orgId){
        pendingProvisionExists = true
      }
    }
    return pendingProvisionExists
  }
  async getRoles(){
    return this._roles
  }
  async getMembers() {
    return this._members;
  }
  async getOrgs() {
    return this._orgs;
  }
  async userExists(searchEmail: string) {
    debug(`\nchecking if ${searchEmail} exists in group`);
    if (
      this._members.some(
        (e) => e.email.toUpperCase() == searchEmail.toUpperCase(),
      )
    ) {
      debug(`${searchEmail} found in group`);
      return true;
    } else {
      debug(`${searchEmail} NOT found in group`);
      return false;
    }
  }
  async inviteUserToOrg(email: string, role: string, org: string) {
    let inviteBody = `{
            "email": "${email}"
        }`;
    if (
      role.toUpperCase() == 'ADMIN' ||
      role.toUpperCase() == 'ADMINISTRATOR'
    ) {
      inviteBody = `{
                "email": "${email}",
                "isAdmin": true
            }
            `;
    }

    try {
      return await this._requestManager.request({
        verb: 'POST',
        url: `/org/${org}/invite`,
        body: inviteBody,
      });
    } catch (err: any) {
      utils.log(err);
    }
  }
  private async queueSnykMembership(snykMembership: PendingMembership) {
    this._snykMembershipQueue.push(snykMembership);
  }
  private async queueSnykMembershipRemoval(snykMembershipRemoval: {
    userEmail: string;
    role: string;
    org: string;
  }) {
    this._snykMembershipRemovalQueue.push(snykMembershipRemoval);
  }
  async getOrgIdFromName(orgName: string) {
    //let result = '';
    const groupOrgs = await this.getOrgs();
    for (const o of groupOrgs) {
      debug(`Comparing ${o.name} to ${orgName}...`);
      if (o.name == orgName) {
        debug(`returning ${o.id}`);
        return o.id;
      }
    }
    //return result;
    throw new customErrors.OrgIdNotFound(
      `Org ID not found for Org Name "${orgName}" - check the name is correct`,
    );
  }
  async getUserIdFromEmail(userEmail: string) {
    for (const gm of this._members) {
      if (gm.email != null) {
        if (gm.email.toUpperCase() == userEmail.toUpperCase()) {
          return gm.id;
        }
      }
    }
    return '';
  }
  private async processQueue(queue: any[]) {
    const results = [];
    var numProcessed: number = 0;
    await pMap (
      queue,
      async (reqData) => {
        try {
          debug(`\nreqData: ${JSON.stringify(reqData, null, 2)}`);
          const res = await this._requestManager.request(reqData);
          utils.printProgress(` - ${++numProcessed}/${queue.length} completed`);
          results.push(res);
        } catch (e: any) {
          utils.log(`${e.data.message}`);
          debug(e);
        }
      },
      {concurrency: 10}
    )
    ;
    //utils.log(` - ${results.length} updates successfully processed`);
  }
  private async addSnykMembershipsFromQueue() {
    let userMembershipQueue = [];
    // custom role memberships can not be added to org in one call
    // must add as collaborator and then update role to the desired one
    // because the update role in these cases needs to come after, we defer them
    // to a separate list which is called after userMembershipQueue[]
    let dependentRoleUpdateQueue =[];

    for (const sm of this._snykMembershipQueue) {
      try {
        await this.validateUserMembership(sm);
        if (
          this.pendingInviteExistsInGroup(sm.userEmail) == false || common.AUTO_PROVISION_FLAG || await this.userExists(sm.userEmail) || common.INVITE_TO_ALL_ORGS_FLAG
        ) {
          if ((await this.userExists(sm.userEmail)) == true) {
            //begin user exists in group flow
            const orgId = await this.getOrgIdFromName(sm.org);
            const userId = await this.getUserIdFromEmail(sm.userEmail);
            debug('userExistsInOrg: ' + sm.userExistsInOrg);
            if (sm.userExistsInOrg == 'true') {
                //user already in org, so just update existing records
                debug('Updating existing group-org member role');
                //change role -- update member of org
                let updateBody = `{
                  "rolePublicId": "${this.mapRolesToIds()[sm.role.toUpperCase()]}"
                }`;
                debug(`updateBody: ${updateBody}`);
                userMembershipQueue.push({
                  verb: 'PUT',
                  url: `/org/${orgId}/members/update/${userId}`,
                  body: updateBody,
                });
            } else {
              if (this.checkIfUserIsGroupAdmin(sm.userEmail)){
                utils.log(`  - skipping ${sm.userEmail}, already a Group Admin`)
              }else{
                // user not in org, add them
                let userBody = `{
                  "userId": "${userId}",
                  "role": "collaborator"
                }`;

                userMembershipQueue.push({
                  verb: 'POST',
                  url: `/group/${this.id}/org/${orgId}/members`,
                  body: userBody,
                });
                //assign user to custom role after adding them to org
                let updateBody = `{
                  "rolePublicId": "${this.mapRolesToIds()[sm.role.toUpperCase()]}"
                }`;
                dependentRoleUpdateQueue.push({
                  verb: 'PUT',
                  url: `/org/${orgId}/members/update/${userId}`,
                  body: updateBody,
                })              
            }
          }
          } else {
            //user not in group, auto provision or send invite
            let orgId = await this.getOrgIdFromName(sm.org);
            //provision flow
            if (common.AUTO_PROVISION_FLAG){
              if (this.pendingProvisionExists(sm.userEmail, orgId)){
                utils.log(
                  ` - ${sm.userEmail} already provisioned to "${sm.org}" organization [orgId: ${orgId}], skipping...`,
                );
              }else{
                utils.log(
                  `  - provisioning ${sm.userEmail} to "${sm.org}" organization [orgId: ${orgId}]...`,
                );
                let provisionBody = `{
                  "email": "${sm.userEmail}",
                  "rolePublicId" : "${this.mapRolesToIds()[sm.role.toUpperCase()]}"
                }`;
                userMembershipQueue.push({
                  verb: 'POST',
                  url: `/org/${orgId}/provision`,
                  body: provisionBody,
                });
              }

            //invite flow
            }else{
              //if (this.pendingInviteExistsInGroup(sm.userEmail) == false){
                utils.log(
                  `  - ${sm.userEmail} not in ${this.name}, sending invite [orgId: ${orgId}]...`,
                );
  
                let inviteBody = `{
                  "email": "${sm.userEmail}",
                  "role": "${await this.mapRolesToIds()[sm.role.toUpperCase()]}"
                }`;
                userMembershipQueue.push({
                  verb: 'POST',
                  useRESTApi: true,
                  url: `/orgs/${orgId}/invites?version=2022-10-06`,
                  body: inviteBody,
                });

                
                this._pendingInvites.push({
                  orgId: orgId,
                  email: sm.userEmail,
                  role: sm.role
                })
              //}
            }
          }
        } else {
          utils.log(`  - skipping ${sm.userEmail}, has an invitiation pending`,);
        }
      } catch (err: any) {
        console.log(err);
      }
    }
    
    if (userMembershipQueue.length > 0) {
      debug(userMembershipQueue);
      utils.log(`\n  Processing ${userMembershipQueue.length} requests to API (userMembershipQueue)`);
      await this.processQueue(userMembershipQueue);
      console.log()
    }

    if (dependentRoleUpdateQueue.length > 0) {
      debug(dependentRoleUpdateQueue);
      utils.log(`  Processing ${dependentRoleUpdateQueue.length} requests to API (dependentRoleUpdateQueue)`);
      await this.processQueue(dependentRoleUpdateQueue);
      console.log()
    }
  }

  private async removeSnykMembershipsFromQueue() {
    let membershipRemovalQueue = [];

    for (const mr of this._snykMembershipRemovalQueue) {
      //get orgId and userId for removal
      const orgId = await this.getOrgIdFromName(mr.org);
      const userId = await this.getUserIdFromEmail(mr.userEmail);
      membershipRemovalQueue.push({
        verb: 'DELETE',
        url: `/org/${orgId}/members/${userId}`,
      });
    }

    debug(membershipRemovalQueue);

    this.processQueue(membershipRemovalQueue);
  }
  async addNewMemberships() {
    utils.log(`  Checking for memberships to add...`);
    var membershipsToAdd = await this.getSnykMembershipsToAdd();
    utils.log(`  - ${membershipsToAdd.length} Snyk memberships to add found`);
    debug(membershipsToAdd);

    let i = 1;
    for (const snykMembership of membershipsToAdd) {
      utils.log(
        `  ${snykMembership.org} | ${snykMembership.userEmail} | ${snykMembership.role}`,
      );
      if (!common.DRY_RUN_FLAG) {
        await this.queueSnykMembership(snykMembership);
      }
      i++;
    }
    await this.addSnykMembershipsFromQueue();
  }
  async removeStaleMemberships() {
    console.log();
    utils.log(`Checking for memberships to remove...`);
    var membershipsToRemove = await this.getSnykMembershipsToRemove();

    utils.log(
      ` - ${membershipsToRemove.length} Snyk memberships to remove found`,
    );
    debug(membershipsToRemove);

    let i = 1;
    for (const snykMembership of membershipsToRemove) {
      utils.log(
        ` - ${i} of ${membershipsToRemove.length} [${snykMembership.org} | ${snykMembership.userEmail}]`,
      );
      if (!common.DRY_RUN_FLAG) {
        await this.queueSnykMembershipRemoval(snykMembership);
      }
      i++;
    }
    this.removeSnykMembershipsFromQueue();
  }
  private sourceIsV1() {
    return (this.sourceMemberships as v1Group).members !== undefined;
  }
  private async getSnykMembershipsToAdd() {
    var result = [];
    result = await this.do_getSnykMembershipsToAddV1();
    return result;
  }
  private async do_getSnykMembershipsToAddV1() {
    var result: PendingMembership[] = [];

    for (const um of (this.sourceMemberships as v1Group).members) {
      var orgMatch: boolean = false;
      var roleMatch: boolean = false;

      for (const gm of this._members) {
        if (gm.groupRole != 'admin') {
          if (gm.email.toUpperCase() == um.userEmail.toUpperCase()) {
            for (const org of gm.orgs) {
              if (org.name == um.org) {
                orgMatch = true;
                if (org.role.toUpperCase() == um.role.toUpperCase()) {
                  if (
                    org.role.toUpperCase() == "ADMIN" &&
                    um.role.toUpperCase() == "ADMIN" &&
                    this._customAdminRoleExists ||
                    org.role.toUpperCase() == "COLLABORATOR" &&
                    um.role.toUpperCase() == "COLLABORATOR" &&
                    this._customCollaboratorRoleExists ){
                      roleMatch = false
                    }else{
                      roleMatch = true;
                      break;
                    }
                }
              }
            }
          }
        }
      }
      if (!roleMatch) {
        result.push({
          userEmail: `${um.userEmail}`,
          role: `${um.role}`,
          org: `${um.org}`,
          group: `${um.group}`,
          userExistsInOrg: `${orgMatch}`
        });
      }
    }
    return result;
  }
  private async getSnykMembershipsToRemove() {
    let result = [];

      result = await this.do_getSnykMembershipsToRemoveV1();

    return result;
  }
  private async do_getSnykMembershipsToRemoveV1() {
    let result = [];
    for (const gm of this._members) {
      if (gm.groupRole != 'admin') {
        for (const org of gm.orgs) {
          let roleMatch: boolean = false;
          for (const um of (this.sourceMemberships as v1Group).members) {
            if (um.userEmail.toUpperCase() == gm.email.toUpperCase()) {
              if (um.org == org.name) {
                if (um.role.toUpperCase() == org.role.toUpperCase()) {
                  roleMatch = true;
                  break;
                }
              }
            }
          }

          if (!roleMatch) {
            result.push({
              userEmail: `${gm.email}`,
              role: `${org.role}`,
              org: `${org.name}`,
            });
          }
        }
      }
    }
    debug(`result: ${result}`);
    return result;
  }
 
  /* private do_findOrgUserRolesInSnyk(
    userEmail: string,
    userRole: string,
    userOrg: string,
  ) {
    let roleMatch: boolean = false;
    let orgMatch: boolean = false;
    for (const gm of this._members) {
      if (!roleMatch && gm.groupRole != 'admin' && gm.groupRole != 'viewer') {
        if (gm.email.toUpperCase() == userEmail.toUpperCase()) {
          for (const org of gm.orgs) {
            if (org.name == userOrg) {
              orgMatch = true;
              if (org.role.toUpperCase() == userRole.toUpperCase()) {
                if (
                  org.role.toUpperCase() == "ADMIN" &&
                  userRole.toUpperCase() == "ADMIN" &&
                  this._customAdminRoleExists ||
                  org.role.toUpperCase() == "COLLABORATOR" &&
                  userRole.toUpperCase() == "COLLABORATOR" &&
                  this._customCollaboratorRoleExists 
                ) {
                  roleMatch = false
                } else {
                  roleMatch = true;
                  break;
                }
              }
            }
          }
        }
      }
    }
    return {
      roleMatch: roleMatch,
      orgMatch: orgMatch,
    };
  } */

  private async validateUserMembership(snykMembership: {
    userEmail: string;
    role: string;
    org: string;
  }) {
    var reEmail: RegExp = /\S+@\S+\.\S+/;
    //if roles passed is not in groups valid roles then throw error
    if (!(snykMembership.role.toUpperCase() in this.mapRolesToIds())){
      // console.log(`snykMembership.role: ${snykMembership.role}`)
      // console.log(`mappedRolesToIds: ${this.mapRolesToIds()}`)
      throw new customErrors.InvalidRole(
        `Invalid value for role`,
      );
    }
    if (reEmail.test(snykMembership.userEmail) == false) {
      //console.log('email regex = false')
      throw new customErrors.InvalidEmail(
        'Invalid email address format. Please verify',
      );
    }
    return true;
  }
}
