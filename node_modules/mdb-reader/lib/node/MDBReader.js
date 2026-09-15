import Database from "./Database.js";
import PageType, { assertPageType } from "./PageType.js";
import { isSysObjectType, isSystemObject, SysObjectType } from "./SysObject.js";
import Table from "./Table.js";
const MSYS_OBJECTS_TABLE = "MSysObjects";
const MSYS_OBJECTS_PAGE = 2;
export default class MDBReader {
    /**
     * @param buffer Buffer of the database.
     */
    constructor(buffer, { password } = {}) {
        this.buffer = buffer;
        assertPageType(this.buffer, PageType.DatabaseDefinitionPage);
        this.db = new Database(this.buffer, password ?? "");
        const mSysObjectsTable = new Table(MSYS_OBJECTS_TABLE, this.db, MSYS_OBJECTS_PAGE).getData({
            columns: ["Id", "Name", "Type", "Flags"],
        });
        this.sysObjects = mSysObjectsTable.map((mSysObject) => {
            const objectType = mSysObject.Type & 0x7f;
            return {
                objectName: mSysObject.Name,
                objectType: isSysObjectType(objectType) ? objectType : null,
                tablePage: mSysObject.Id & 0x00ffffff,
                flags: mSysObject.Flags,
            };
        });
    }
    /**
     * Date when the database was created
     */
    getCreationDate() {
        return this.db.getCreationDate();
    }
    /**
     * Database password
     */
    getPassword() {
        return this.db.getPassword();
    }
    /**
     * Default sort order
     */
    getDefaultSortOrder() {
        return this.db.getDefaultSortOrder();
    }
    /**
     * Returns an array of table names.
     *
     * @param normalTables Includes user tables. Default true.
     * @param systemTables Includes system tables. Default false.
     * @param linkedTables Includes linked tables. Default false.
     */
    getTableNames({ normalTables, systemTables, linkedTables, } = { normalTables: true, systemTables: false, linkedTables: false }) {
        const filteredSysObjects = [];
        for (const sysObject of this.sysObjects) {
            if (sysObject.objectType === SysObjectType.Table) {
                if (!isSystemObject(sysObject)) {
                    if (normalTables) {
                        filteredSysObjects.push(sysObject);
                    }
                }
                else if (systemTables) {
                    filteredSysObjects.push(sysObject);
                }
            }
            else if (sysObject.objectType === SysObjectType.LinkedTable && linkedTables) {
                filteredSysObjects.push(sysObject);
            }
        }
        return filteredSysObjects.map((o) => o.objectName);
    }
    /**
     * Returns a table by its name.
     *
     * @param name Name of the table. Case sensitive.
     */
    getTable(name) {
        const sysObject = this.sysObjects
            .filter((o) => o.objectType === SysObjectType.Table)
            .find((o) => o.objectName === name);
        if (!sysObject) {
            throw new Error(`Could not find table with name ${name}`);
        }
        return new Table(name, this.db, sysObject.tablePage);
    }
}
