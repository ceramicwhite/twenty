import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';

import { v4 } from 'uuid';
import { DataSource, EntityManager, Repository } from 'typeorm';

import { CreateRemoteServerInput } from 'src/engine/metadata-modules/remote-server/dtos/create-remote-server.input';
import {
  RemoteServerEntity,
  RemoteServerType,
} from 'src/engine/metadata-modules/remote-server/remote-server.entity';
import { EnvironmentService } from 'src/engine/integrations/environment/environment.service';
import { encryptText } from 'src/engine/core-modules/auth/auth.util';
import {
  validateObjectAgainstInjections,
  validateStringAgainstInjections,
} from 'src/engine/metadata-modules/remote-server/utils/validate-remote-server-input.utils';
import { ForeignDataWrapperQueryFactory } from 'src/engine/api/graphql/workspace-query-builder/factories/foreign-data-wrapper-query.factory';
import { RemoteTableService } from 'src/engine/metadata-modules/remote-server/remote-table/remote-table.service';
import { UpdateRemoteServerInput } from 'src/engine/metadata-modules/remote-server/dtos/update-remote-server.input';
import { WorkspaceDataSourceService } from 'src/engine/workspace-datasource/workspace-datasource.service';
import { updateRemoteServerRawQuery } from 'src/engine/metadata-modules/remote-server/utils/build-update-remote-server-raw-query.utils';

@Injectable()
export class RemoteServerService<T extends RemoteServerType> {
  constructor(
    @InjectRepository(RemoteServerEntity, 'metadata')
    private readonly remoteServerRepository: Repository<
      RemoteServerEntity<RemoteServerType>
    >,
    @InjectDataSource('metadata')
    private readonly metadataDataSource: DataSource,
    private readonly environmentService: EnvironmentService,
    private readonly foreignDataWrapperQueryFactory: ForeignDataWrapperQueryFactory,
    private readonly remoteTableService: RemoteTableService,
    private readonly workspaceDataSourceService: WorkspaceDataSourceService,
  ) {}

  async createOneRemoteServer(
    remoteServerInput: CreateRemoteServerInput<T>,
    workspaceId: string,
  ): Promise<RemoteServerEntity<RemoteServerType>> {
    this.validateRemoteServerInputAgainstInjections(remoteServerInput);

    const foreignDataWrapperId = v4();

    let remoteServerToCreate = {
      ...remoteServerInput,
      workspaceId,
      foreignDataWrapperId,
    };

    if (remoteServerInput.userMappingOptions) {
      remoteServerToCreate = {
        ...remoteServerToCreate,
        userMappingOptions: {
          ...remoteServerInput.userMappingOptions,
          password: this.encryptPassword(
            remoteServerInput.userMappingOptions.password,
          ),
        },
      };
    }

    return this.metadataDataSource.transaction(
      async (entityManager: EntityManager) => {
        const createdRemoteServer = entityManager.create(
          RemoteServerEntity,
          remoteServerToCreate,
        );

        const foreignDataWrapperQuery =
          this.foreignDataWrapperQueryFactory.createForeignDataWrapper(
            createdRemoteServer.foreignDataWrapperId,
            remoteServerInput.foreignDataWrapperType,
            remoteServerInput.foreignDataWrapperOptions,
          );

        await entityManager.query(foreignDataWrapperQuery);

        if (remoteServerInput.userMappingOptions) {
          const userMappingQuery =
            this.foreignDataWrapperQueryFactory.createUserMapping(
              createdRemoteServer.foreignDataWrapperId,
              remoteServerInput.userMappingOptions,
            );

          await entityManager.query(userMappingQuery);
        }

        await entityManager.save(RemoteServerEntity, createdRemoteServer);

        return createdRemoteServer;
      },
    );
  }

  async updateOneRemoteServer(
    remoteServerInput: UpdateRemoteServerInput<T>,
    workspaceId: string,
  ): Promise<RemoteServerEntity<RemoteServerType>> {
    this.validateRemoteServerInputAgainstInjections(remoteServerInput);

    const remoteServer = await this.findOneByIdWithinWorkspace(
      remoteServerInput.id,
      workspaceId,
    );

    if (!remoteServer) {
      throw new NotFoundException('Remote server does not exist');
    }

    const currentRemoteTablesForServer =
      await this.remoteTableService.findCurrentRemoteTablesByServerId({
        remoteServerId: remoteServer.id,
        workspaceId,
      });

    if (currentRemoteTablesForServer.length > 0) {
      throw new ForbiddenException(
        'Cannot update remote server with synchronized tables',
      );
    }

    const foreignDataWrapperId = remoteServer.foreignDataWrapperId;

    let partialRemoteServerWithUpdates = {
      ...remoteServerInput,
      workspaceId,
      foreignDataWrapperId,
    };

    if (partialRemoteServerWithUpdates?.userMappingOptions?.password) {
      partialRemoteServerWithUpdates = {
        ...partialRemoteServerWithUpdates,
        userMappingOptions: {
          ...partialRemoteServerWithUpdates.userMappingOptions,
          password: this.encryptPassword(
            partialRemoteServerWithUpdates.userMappingOptions.password,
          ),
        },
      };
    }

    return this.metadataDataSource.transaction(
      async (entityManager: EntityManager) => {
        const updatedRemoteServer = await this.updateRemoteServer(
          partialRemoteServerWithUpdates,
        );

        if (partialRemoteServerWithUpdates.foreignDataWrapperOptions) {
          const foreignDataWrapperQuery =
            this.foreignDataWrapperQueryFactory.updateForeignDataWrapper({
              foreignDataWrapperId,
              foreignDataWrapperOptions:
                partialRemoteServerWithUpdates.foreignDataWrapperOptions,
            });

          await entityManager.query(foreignDataWrapperQuery);
        }

        if (partialRemoteServerWithUpdates.userMappingOptions) {
          const userMappingQuery =
            this.foreignDataWrapperQueryFactory.updateUserMapping(
              foreignDataWrapperId,
              partialRemoteServerWithUpdates.userMappingOptions,
            );

          await entityManager.query(userMappingQuery);
        }

        return updatedRemoteServer;
      },
    );
  }

  private validateRemoteServerInputAgainstInjections(
    remoteServerInput: CreateRemoteServerInput<T> | UpdateRemoteServerInput<T>,
  ) {
    if (remoteServerInput.foreignDataWrapperOptions) {
      validateObjectAgainstInjections(
        remoteServerInput.foreignDataWrapperOptions,
      );
    }

    if (remoteServerInput.userMappingOptions) {
      validateObjectAgainstInjections(remoteServerInput.userMappingOptions);
    }
  }

  async deleteOneRemoteServer(
    id: string,
    workspaceId: string,
  ): Promise<RemoteServerEntity<RemoteServerType>> {
    validateStringAgainstInjections(id);

    const remoteServer = await this.remoteServerRepository.findOne({
      where: {
        id,
        workspaceId,
      },
    });

    if (!remoteServer) {
      throw new NotFoundException('Remote server does not exist');
    }

    await this.remoteTableService.unsyncAll(workspaceId, remoteServer);

    return this.metadataDataSource.transaction(
      async (entityManager: EntityManager) => {
        await entityManager.query(
          `DROP SERVER "${remoteServer.foreignDataWrapperId}" CASCADE`,
        );
        await entityManager.delete(RemoteServerEntity, id);

        return remoteServer;
      },
    );
  }

  public async findOneByIdWithinWorkspace(id: string, workspaceId: string) {
    return this.remoteServerRepository.findOne({
      where: {
        id,
        workspaceId,
      },
    });
  }

  public async findManyByTypeWithinWorkspace<T extends RemoteServerType>(
    foreignDataWrapperType: T,
    workspaceId: string,
  ) {
    return this.remoteServerRepository.find({
      where: {
        foreignDataWrapperType,
        workspaceId,
      },
    });
  }

  private encryptPassword(password: string) {
    const key = this.environmentService.get('LOGIN_TOKEN_SECRET');

    return encryptText(password, key);
  }

  private async updateRemoteServer(
    remoteServerToUpdate: DeepPartial<RemoteServerEntity<RemoteServerType>> &
      Pick<RemoteServerEntity<RemoteServerType>, 'workspaceId' | 'id'>,
  ): Promise<RemoteServerEntity<RemoteServerType>> {
    const [parameters, rawQuery] =
      updateRemoteServerRawQuery(remoteServerToUpdate);

    const updateResult = await this.workspaceDataSourceService.executeRawQuery(
      rawQuery,
      parameters,
      remoteServerToUpdate.workspaceId,
    );

    return updateResult[0][0];
  }
}
